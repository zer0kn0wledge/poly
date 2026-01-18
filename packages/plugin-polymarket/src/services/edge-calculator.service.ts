/**
 * Edge Calculator Service
 *
 * Calculates trading edge by comparing technical analysis probability estimates
 * against Polymarket implied probabilities. Uses Kelly criterion for position sizing.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { CoinGeckoDataService, type FullAnalysisData } from './coingecko-data.service';
import { TechnicalAnalysisService, type TechnicalIndicators, type PriceProjection } from './technical-analysis.service';
import { CryptoMarketDiscoveryService, type CryptoPriceMarket } from './crypto-market-discovery.service';

// ============= Types =============

export interface TradingOpportunity {
  // Market info
  market: CryptoPriceMarket;

  // Technical analysis
  technicalAnalysis: TechnicalIndicators;
  priceProjection: PriceProjection;

  // Price data
  currentPrice: number;
  targetPrice: number;
  priceChange24h: number;
  distanceToTarget: number;  // Percentage

  // Edge calculation
  marketImpliedProbability: number;  // From YES price
  estimatedProbability: number;      // From TA
  edge: number;                      // estimated - implied
  edgePercent: number;               // Edge as percentage

  // Position sizing (Kelly)
  kellyFraction: number;
  recommendedSize: number;  // USD
  maxSize: number;          // Risk-adjusted max

  // Trading recommendation
  side: 'YES' | 'NO';
  confidence: number;       // 0-100
  rating: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'AVOID';

  // Reasoning
  reasoning: string;
  riskFactors: string[];
}

export interface EdgeCalculatorConfig {
  minEdge: number;              // Minimum edge to consider (default: 0.05 = 5%)
  maxKelly: number;             // Maximum Kelly fraction (default: 0.25)
  bankroll: number;             // Total bankroll in USD
  maxPositionSize: number;      // Max single position (default: 100)
  minLiquidity: number;         // Min market liquidity (default: 5000)
  minVolume24h: number;         // Min 24h volume (default: 1000)
  maxDaysToExpiry: number;      // Max days to expiration (default: 30)
}

const DEFAULT_CONFIG: EdgeCalculatorConfig = {
  minEdge: 0.05,
  maxKelly: 0.25,
  bankroll: 1000,
  maxPositionSize: 100,
  minLiquidity: 5000,
  minVolume24h: 1000,
  maxDaysToExpiry: 30,
};

// ============= Service =============

export class EdgeCalculatorService extends Service {
  static readonly serviceType = 'edge-calculator';
  readonly capabilityDescription = 'Calculates trading edge using technical analysis vs market odds';

  private runtime: IAgentRuntime | null = null;
  private coinGeckoService: CoinGeckoDataService | null = null;
  private technicalAnalysisService: TechnicalAnalysisService | null = null;
  private marketDiscoveryService: CryptoMarketDiscoveryService | null = null;
  private config: EdgeCalculatorConfig = DEFAULT_CONFIG;

  static async start(runtime: IAgentRuntime): Promise<EdgeCalculatorService> {
    const service = new EdgeCalculatorService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info('[EdgeCalculator] Initializing edge calculator service');

    // Load config from environment
    this.config = {
      ...DEFAULT_CONFIG,
      bankroll: parseFloat(process.env.POLYMARKET_BANKROLL || '1000'),
      maxPositionSize: parseFloat(process.env.POLYMARKET_MAX_POSITION_SIZE || '100'),
      minEdge: parseFloat(process.env.POLYMARKET_MIN_EDGE || '0.05'),
    };

    // Get dependent services after initialization
    setTimeout(() => this.linkServices(), 5000);

    logger.info({ config: this.config }, '[EdgeCalculator] Service initialized');
  }

  private linkServices(): void {
    if (!this.runtime) return;

    this.coinGeckoService = this.runtime.getService<CoinGeckoDataService>('coingecko-data');
    this.technicalAnalysisService = this.runtime.getService<TechnicalAnalysisService>('technical-analysis');
    this.marketDiscoveryService = this.runtime.getService<CryptoMarketDiscoveryService>('crypto-market-discovery');

    logger.info({
      hasCoinGecko: !!this.coinGeckoService,
      hasTA: !!this.technicalAnalysisService,
      hasDiscovery: !!this.marketDiscoveryService,
    }, '[EdgeCalculator] Services linked');
  }

  async stop(): Promise<void> {
    logger.info('[EdgeCalculator] Service stopped');
  }

  // ============= Core Edge Calculation =============

  /**
   * Find all trading opportunities across crypto markets
   */
  async findOpportunities(customConfig?: Partial<EdgeCalculatorConfig>): Promise<TradingOpportunity[]> {
    const config = { ...this.config, ...customConfig };

    // Ensure services are linked
    if (!this.coinGeckoService || !this.technicalAnalysisService || !this.marketDiscoveryService) {
      this.linkServices();
      if (!this.coinGeckoService || !this.technicalAnalysisService || !this.marketDiscoveryService) {
        logger.warn('[EdgeCalculator] Required services not available');
        return [];
      }
    }

    try {
      logger.info('[EdgeCalculator] Scanning for trading opportunities');

      // Step 1: Get crypto price markets
      const markets = await this.marketDiscoveryService.getCryptoPriceMarkets(
        config.minVolume24h,
        config.minLiquidity
      );

      logger.info({ marketCount: markets.length }, '[EdgeCalculator] Found crypto markets');

      if (markets.length === 0) {
        return [];
      }

      // Step 2: Filter by expiry
      const validMarkets = markets.filter(m => m.daysToExpiry <= config.maxDaysToExpiry);
      logger.info({ validCount: validMarkets.length }, '[EdgeCalculator] Markets within expiry window');

      // Step 3: Group by coin to minimize API calls
      const marketsByCoin = new Map<string, CryptoPriceMarket[]>();
      for (const market of validMarkets) {
        const existing = marketsByCoin.get(market.coin) || [];
        existing.push(market);
        marketsByCoin.set(market.coin, existing);
      }

      // Step 4: Analyze each coin and its markets
      const opportunities: TradingOpportunity[] = [];

      for (const [coinId, coinMarkets] of marketsByCoin) {
        try {
          // Get full analysis data for coin
          const analysisData = await this.coinGeckoService.getFullAnalysisData(coinId);
          if (!analysisData) {
            logger.warn({ coinId }, '[EdgeCalculator] No analysis data for coin');
            continue;
          }

          // Run technical analysis on 30-day OHLC
          const ta = this.technicalAnalysisService.analyzeAsset(
            analysisData.ohlc30d,
            analysisData.marketChart30d?.prices?.map(p => p[1])
          );

          // Analyze each market for this coin
          for (const market of coinMarkets) {
            const opportunity = this.analyzeMarket(market, analysisData, ta, config);
            if (opportunity && Math.abs(opportunity.edge) >= config.minEdge) {
              opportunities.push(opportunity);
            }
          }

          // Rate limit between coins
          await new Promise(r => setTimeout(r, 200));

        } catch (error) {
          logger.warn({ coinId, error: String(error) }, '[EdgeCalculator] Error analyzing coin');
        }
      }

      // Step 5: Sort by edge magnitude
      opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

      logger.info({
        total: opportunities.length,
        strongBuy: opportunities.filter(o => o.rating === 'STRONG_BUY').length,
        buy: opportunities.filter(o => o.rating === 'BUY').length,
      }, '[EdgeCalculator] Found opportunities');

      return opportunities;

    } catch (error) {
      logger.error({ error: String(error) }, '[EdgeCalculator] Error finding opportunities');
      return [];
    }
  }

  /**
   * Analyze a single market for trading opportunity
   */
  private analyzeMarket(
    market: CryptoPriceMarket,
    analysisData: FullAnalysisData,
    ta: TechnicalIndicators,
    config: EdgeCalculatorConfig
  ): TradingOpportunity | null {
    if (!this.technicalAnalysisService) return null;

    const currentPrice = analysisData.price.usd;
    const targetPrice = market.targetPrice;

    // Calculate distance to target
    const distanceToTarget = ((targetPrice - currentPrice) / currentPrice) * 100;

    // Get market implied probability from YES price
    const marketImpliedProbability = market.yesPrice;

    // Project price movement using technical analysis
    const projection = this.technicalAnalysisService.projectPriceTarget(
      currentPrice,
      targetPrice,
      ta,
      market.daysToExpiry
    );

    // Determine estimated probability based on direction
    let estimatedProbability: number;
    if (market.direction === 'ABOVE' || market.direction === 'REACH') {
      // Probability of going above target
      estimatedProbability = projection.probability;
    } else {
      // Probability of going below target
      estimatedProbability = 1 - projection.probability;
    }

    // Calculate edge
    const edge = estimatedProbability - marketImpliedProbability;
    const edgePercent = edge * 100;

    // Determine which side to bet
    let side: 'YES' | 'NO';
    let effectiveEdge: number;

    if (edge > 0) {
      // YES is underpriced
      side = 'YES';
      effectiveEdge = edge;
    } else {
      // NO is underpriced
      side = 'NO';
      effectiveEdge = -edge;  // Make positive for Kelly
    }

    // Kelly criterion for position sizing
    const kellyFraction = this.calculateKelly(
      effectiveEdge,
      side === 'YES' ? marketImpliedProbability : (1 - marketImpliedProbability),
      config.maxKelly
    );

    // Calculate recommended size
    const recommendedSize = Math.min(
      kellyFraction * config.bankroll,
      config.maxPositionSize,
      market.liquidity * 0.05  // Max 5% of market liquidity
    );

    // Calculate confidence (0-100)
    const confidence = this.calculateConfidence(effectiveEdge, ta, market, projection);

    // Determine rating
    const rating = this.determineRating(effectiveEdge, confidence, market);

    // Generate reasoning
    const reasoning = this.generateReasoning(
      market, currentPrice, targetPrice, ta, projection, edge, side
    );

    // Identify risk factors
    const riskFactors = this.identifyRiskFactors(market, ta, projection, config);

    return {
      market,
      technicalAnalysis: ta,
      priceProjection: projection,
      currentPrice,
      targetPrice,
      priceChange24h: analysisData.price.usd_24h_change,
      distanceToTarget,
      marketImpliedProbability,
      estimatedProbability,
      edge,
      edgePercent,
      kellyFraction,
      recommendedSize,
      maxSize: config.maxPositionSize,
      side,
      confidence,
      rating,
      reasoning,
      riskFactors,
    };
  }

  // ============= Kelly Criterion =============

  /**
   * Calculate Kelly criterion fraction
   * f* = (bp - q) / b
   * where b = odds, p = probability of winning, q = 1-p
   */
  private calculateKelly(edge: number, impliedProb: number, maxKelly: number): number {
    if (edge <= 0) return 0;

    // Convert implied probability to odds
    const odds = (1 / impliedProb) - 1;

    // Our estimated win probability
    const p = impliedProb + edge;
    const q = 1 - p;

    // Kelly formula
    const kelly = (odds * p - q) / odds;

    // Apply fractional Kelly (half Kelly is safer)
    const fractionalKelly = kelly * 0.5;

    // Cap at maxKelly
    return Math.max(0, Math.min(fractionalKelly, maxKelly));
  }

  // ============= Confidence & Rating =============

  /**
   * Calculate confidence score (0-100)
   */
  private calculateConfidence(
    edge: number,
    ta: TechnicalIndicators,
    market: CryptoPriceMarket,
    projection: PriceProjection
  ): number {
    let score = 50;  // Base score

    // Edge contribution (up to +20)
    score += Math.min(20, edge * 100);

    // TA trend alignment (+10 if strong trend aligns with direction)
    if (ta.trendStrength > 0.6) {
      const targetAbove = market.direction === 'ABOVE' || market.direction === 'REACH';
      const trendUp = ta.trendDirection === 'BULLISH';
      if ((targetAbove && trendUp) || (!targetAbove && !trendUp)) {
        score += 10;
      }
    }

    // RSI alignment (+5)
    if (ta.rsiSignal !== 'NEUTRAL') {
      const rsiBullish = ta.rsiSignal === 'OVERSOLD';
      const targetAbove = market.direction === 'ABOVE' || market.direction === 'REACH';
      if ((targetAbove && rsiBullish) || (!targetAbove && !rsiBullish)) {
        score += 5;
      }
    }

    // MACD alignment (+5)
    if (ta.macdSignal !== 'NEUTRAL') {
      const macdBullish = ta.macdSignal === 'BULLISH';
      const targetAbove = market.direction === 'ABOVE' || market.direction === 'REACH';
      if ((targetAbove && macdBullish) || (!targetAbove && !macdBullish)) {
        score += 5;
      }
    }

    // Liquidity confidence (+5 for high liquidity)
    if (market.liquidity > 20000) score += 5;
    else if (market.liquidity < 5000) score -= 5;

    // Time to expiry (-5 if too short)
    if (market.daysToExpiry < 3) score -= 10;
    else if (market.daysToExpiry < 7) score -= 5;

    // Projection confidence (+/- based on projection)
    if (projection.probability > 0.7 || projection.probability < 0.3) {
      score += 5;  // Strong conviction
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Determine trading rating
   */
  private determineRating(
    edge: number,
    confidence: number,
    market: CryptoPriceMarket
  ): 'STRONG_BUY' | 'BUY' | 'HOLD' | 'AVOID' {
    // Strong buy: High edge + high confidence + good liquidity
    if (edge >= 0.15 && confidence >= 70 && market.liquidity >= 10000) {
      return 'STRONG_BUY';
    }

    // Buy: Decent edge + decent confidence
    if (edge >= 0.08 && confidence >= 55) {
      return 'BUY';
    }

    // Hold: Some edge but not compelling
    if (edge >= 0.05 && confidence >= 45) {
      return 'HOLD';
    }

    // Avoid: Low edge or low confidence
    return 'AVOID';
  }

  // ============= Reasoning & Risk =============

  /**
   * Generate human-readable reasoning
   */
  private generateReasoning(
    market: CryptoPriceMarket,
    currentPrice: number,
    targetPrice: number,
    ta: TechnicalIndicators,
    projection: PriceProjection,
    edge: number,
    side: 'YES' | 'NO'
  ): string {
    const coinName = market.coinSymbol;
    const direction = market.direction.toLowerCase();
    const distPct = Math.abs(((targetPrice - currentPrice) / currentPrice) * 100).toFixed(1);
    const edgePct = (edge * 100).toFixed(1);
    const marketPct = (market.yesPrice * 100).toFixed(0);
    const modelPct = (projection.probability * 100).toFixed(0);

    let reasoning = `${coinName} at $${currentPrice.toLocaleString()} is ${distPct}% ${currentPrice < targetPrice ? 'below' : 'above'} $${targetPrice.toLocaleString()} target. `;

    reasoning += `Market prices YES at ${marketPct}%, TA model suggests ${modelPct}% probability. `;

    reasoning += `Technical signals: ${ta.trendDirection || 'NEUTRAL'} trend (${((ta.trendStrength || 0) * 100).toFixed(0)}% strength), `;
    reasoning += `RSI ${(ta.rsi || 50).toFixed(0)} (${ta.rsiSignal || 'NEUTRAL'}), MACD ${ta.macdSignal || 'NEUTRAL'}. `;

    if (edge > 0) {
      reasoning += `Edge: +${edgePct}% - ${side} appears underpriced.`;
    } else {
      reasoning += `Edge: ${edgePct}% - ${side} appears underpriced.`;
    }

    return reasoning;
  }

  /**
   * Identify risk factors for the trade
   */
  private identifyRiskFactors(
    market: CryptoPriceMarket,
    ta: TechnicalIndicators,
    projection: PriceProjection,
    config: EdgeCalculatorConfig
  ): string[] {
    const risks: string[] = [];

    // Liquidity risk
    if (market.liquidity < 10000) {
      risks.push('Low liquidity - may have slippage');
    }

    // Time risk
    if (market.daysToExpiry < 5) {
      risks.push('Short time to expiry - limited time for price movement');
    }

    // Volatility risk
    if (ta.atr && ta.atr > 0.05) {
      risks.push('High volatility - price could move unpredictably');
    }

    // Counter-trend risk
    const targetAbove = market.direction === 'ABOVE' || market.direction === 'REACH';
    const trendUp = ta.trendDirection === 'BULLISH';
    if ((targetAbove && !trendUp) || (!targetAbove && trendUp)) {
      risks.push('Trading against current trend');
    }

    // Overbought/oversold risk
    const rsi = ta.rsi || 50;
    if (rsi > 80) {
      risks.push('RSI overbought - potential reversal');
    } else if (rsi < 20) {
      risks.push('RSI oversold - potential reversal');
    }

    // Large distance risk
    const distance = Math.abs(market.targetPrice - projection.currentPrice) / projection.currentPrice;
    if (distance > 0.2) {
      risks.push(`Large price move required (${(distance * 100).toFixed(0)}%)`);
    }

    return risks;
  }

  // ============= Public API =============

  /**
   * Get top trading opportunities
   */
  async getTopOpportunities(limit: number = 5): Promise<TradingOpportunity[]> {
    const all = await this.findOpportunities();
    return all
      .filter(o => o.rating === 'STRONG_BUY' || o.rating === 'BUY')
      .slice(0, limit);
  }

  /**
   * Get opportunities for a specific coin
   */
  async getOpportunitiesForCoin(coinId: string): Promise<TradingOpportunity[]> {
    const all = await this.findOpportunities();
    return all.filter(o => o.market.coin === coinId);
  }

  /**
   * Format opportunities for display
   */
  formatOpportunities(opportunities: TradingOpportunity[]): string {
    if (opportunities.length === 0) {
      return 'No trading opportunities found with sufficient edge.';
    }

    let output = `CRYPTO TRADING OPPORTUNITIES (${opportunities.length} found)\n\n`;

    for (let i = 0; i < opportunities.length; i++) {
      const opp = opportunities[i];
      output += `${i + 1}. [${opp.rating}] ${opp.market.coinSymbol} - ${opp.market.question.slice(0, 60)}...\n`;
      output += `   Price: $${opp.currentPrice.toLocaleString()} | Target: $${opp.targetPrice.toLocaleString()} (${opp.distanceToTarget > 0 ? '+' : ''}${opp.distanceToTarget.toFixed(1)}%)\n`;
      output += `   Market: ${(opp.marketImpliedProbability * 100).toFixed(0)}% | Model: ${(opp.estimatedProbability * 100).toFixed(0)}% | Edge: ${opp.edge > 0 ? '+' : ''}${opp.edgePercent.toFixed(1)}%\n`;
      output += `   Recommendation: BUY ${opp.side} | Size: $${opp.recommendedSize.toFixed(0)} | Confidence: ${opp.confidence.toFixed(0)}%\n`;
      output += `   TA: ${opp.technicalAnalysis.trendDirection} (RSI: ${opp.technicalAnalysis.rsi.toFixed(0)}, MACD: ${opp.technicalAnalysis.macdSignal})\n`;

      if (opp.riskFactors.length > 0) {
        output += `   Risks: ${opp.riskFactors.slice(0, 2).join('; ')}\n`;
      }
      output += '\n';
    }

    return output;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<EdgeCalculatorConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info({ config: this.config }, '[EdgeCalculator] Config updated');
  }
}
