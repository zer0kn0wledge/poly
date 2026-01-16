/**
 * Crypto Price Strategy Service
 *
 * Identifies trading opportunities in crypto price prediction markets
 * by comparing current CoinGecko prices against Polymarket price thresholds.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { PolymarketService } from './polymarket';
import { DataSourcesService } from './data-sources';
import type { PolymarketMarket } from '../types';

// ============= Types =============

export interface CryptoPriceOpportunity {
  market: PolymarketMarket;
  coin: string;
  currentPrice: number;
  targetPrice: number;
  priceDirection: 'above' | 'below';
  distancePercent: number;
  daysToExpiry: number;
  marketOdds: number;
  estimatedProbability: number;
  edge: number;
  recommendation: 'BUY_YES' | 'BUY_NO' | 'NO_EDGE';
  confidence: number;
  reasoning: string;
}

// Coin name mapping for CoinGecko API
const COIN_MAP: Record<string, string> = {
  'bitcoin': 'bitcoin',
  'btc': 'bitcoin',
  'ethereum': 'ethereum',
  'eth': 'ethereum',
  'solana': 'solana',
  'sol': 'solana',
  'xrp': 'ripple',
  'ripple': 'ripple',
  'cardano': 'cardano',
  'ada': 'cardano',
  'dogecoin': 'dogecoin',
  'doge': 'dogecoin',
  'polygon': 'matic-network',
  'matic': 'matic-network',
  'avalanche': 'avalanche-2',
  'avax': 'avalanche-2',
};

// ============= Service =============

export class CryptoPriceStrategyService extends Service {
  static readonly serviceType = 'crypto-price-strategy';
  readonly capabilityDescription = 'Identifies crypto price betting opportunities';

  private runtime: IAgentRuntime | null = null;
  private polymarketService: PolymarketService | null = null;
  private dataSourcesService: DataSourcesService | null = null;

  static async start(runtime: IAgentRuntime): Promise<CryptoPriceStrategyService> {
    const service = new CryptoPriceStrategyService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info('[CryptoPriceStrategy] Initializing crypto price strategy service');

    // Get dependent services (will be available after full initialization)
    setTimeout(() => {
      this.polymarketService = runtime.getService<PolymarketService>('polymarket');
      this.dataSourcesService = runtime.getService<DataSourcesService>('data-sources');
      logger.info('[CryptoPriceStrategy] Services linked', {
        hasPolymarket: !!this.polymarketService,
        hasDataSources: !!this.dataSourcesService,
      });
    }, 5000);
  }

  async stop(): Promise<void> {
    logger.info('[CryptoPriceStrategy] Stopping crypto price strategy service');
  }

  /**
   * Find crypto price betting opportunities
   */
  async findOpportunities(minEdge: number = 0.05): Promise<CryptoPriceOpportunity[]> {
    if (!this.polymarketService || !this.dataSourcesService) {
      // Try to get services again
      if (this.runtime) {
        this.polymarketService = this.runtime.getService<PolymarketService>('polymarket');
        this.dataSourcesService = this.runtime.getService<DataSourcesService>('data-sources');
      }

      if (!this.polymarketService || !this.dataSourcesService) {
        logger.warn('[CryptoPriceStrategy] Required services not available');
        return [];
      }
    }

    try {
      // Step 1: Get crypto markets from Polymarket
      const markets = await this.polymarketService.getCryptoMarkets(50);
      logger.info({ count: markets.length }, '[CryptoPriceStrategy] Fetched crypto markets');

      // Step 2: Filter to price threshold markets
      const priceMarkets = markets.filter(m => this.isPriceMarket(m.question));
      logger.info({ count: priceMarkets.length }, '[CryptoPriceStrategy] Price threshold markets');

      if (priceMarkets.length === 0) {
        return [];
      }

      // Step 3: Get unique coins mentioned
      const coinsNeeded = new Set<string>();
      for (const market of priceMarkets) {
        const coin = this.detectCoin(market.question);
        if (coin) coinsNeeded.add(coin);
      }

      // Step 4: Get current prices from CoinGecko
      const coinIds = Array.from(coinsNeeded);
      const prices = await this.dataSourcesService.getCryptoPrices(coinIds);
      const priceMap = new Map(prices.map(p => [p.symbol.toLowerCase(), p.price]));

      logger.info({ coins: coinIds, prices: Object.fromEntries(priceMap) },
        '[CryptoPriceStrategy] Current prices');

      // Step 5: Analyze each market for opportunities
      const opportunities: CryptoPriceOpportunity[] = [];

      for (const market of priceMarkets) {
        const opportunity = this.analyzeMarket(market, priceMap);
        if (opportunity && Math.abs(opportunity.edge) >= minEdge) {
          opportunities.push(opportunity);
        }
      }

      // Sort by edge magnitude
      opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

      logger.info({ count: opportunities.length, minEdge },
        '[CryptoPriceStrategy] Found opportunities');

      return opportunities;

    } catch (error) {
      logger.error({ error: String(error) }, '[CryptoPriceStrategy] Error finding opportunities');
      return [];
    }
  }

  /**
   * Check if market is a price threshold market
   */
  private isPriceMarket(question: string): boolean {
    const q = question.toLowerCase();
    return /price (above|below|reach|hit|exceed|at or above) \$[\d,]+/i.test(q) ||
           /(bitcoin|btc|ethereum|eth|solana|sol).*(above|below|reach|hit) \$[\d,]+/i.test(q) ||
           /\$([\d,]+).*(bitcoin|btc|ethereum|eth|solana|sol)/i.test(q);
  }

  /**
   * Detect which coin a market is about
   */
  private detectCoin(question: string): string | null {
    const q = question.toLowerCase();

    for (const [keyword, coinId] of Object.entries(COIN_MAP)) {
      if (q.includes(keyword)) {
        return coinId;
      }
    }

    return null;
  }

  /**
   * Extract price threshold from market question
   */
  private extractPriceThreshold(question: string): { price: number; direction: 'above' | 'below' } | null {
    const q = question.toLowerCase();

    // Match patterns like "$100,000", "$100000", "$100k"
    const priceMatch = q.match(/\$([\d,]+(?:\.\d+)?)(k|m)?/i);
    if (!priceMatch) return null;

    let price = parseFloat(priceMatch[1].replace(/,/g, ''));
    const suffix = priceMatch[2]?.toLowerCase();
    if (suffix === 'k') price *= 1000;
    if (suffix === 'm') price *= 1000000;

    // Determine direction
    const direction = /(above|reach|hit|exceed|at or above)/i.test(q) ? 'above' : 'below';

    return { price, direction };
  }

  /**
   * Analyze a market for trading opportunity
   */
  private analyzeMarket(
    market: PolymarketMarket,
    priceMap: Map<string, number>
  ): CryptoPriceOpportunity | null {
    // Get coin
    const coinId = this.detectCoin(market.question);
    if (!coinId) return null;

    // Get current price - need to map coinId back to symbol for lookup
    let currentPrice: number | undefined;
    for (const [symbol, price] of priceMap.entries()) {
      if (COIN_MAP[symbol] === coinId || symbol === coinId.slice(0, 3)) {
        currentPrice = price;
        break;
      }
    }

    // Try direct coinId lookup
    if (!currentPrice) {
      // Map common symbols
      if (coinId === 'bitcoin') currentPrice = priceMap.get('btc');
      if (coinId === 'ethereum') currentPrice = priceMap.get('eth');
      if (coinId === 'solana') currentPrice = priceMap.get('sol');
    }

    if (!currentPrice) {
      logger.debug({ coinId, question: market.question.slice(0, 50) },
        '[CryptoPriceStrategy] No price for coin');
      return null;
    }

    // Get price threshold
    const threshold = this.extractPriceThreshold(market.question);
    if (!threshold) return null;

    // Get market odds
    const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
    const marketOdds = yesToken?.price || 0.5;

    // Calculate days to expiry
    let daysToExpiry = 30; // Default
    if (market.end_date_iso) {
      const endDate = new Date(market.end_date_iso);
      const now = new Date();
      daysToExpiry = Math.max(1, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Calculate distance to threshold
    const distancePercent = ((threshold.price - currentPrice) / currentPrice) * 100;

    // Estimate probability using volatility model
    const estimatedProbability = this.estimateProbability(
      currentPrice,
      threshold.price,
      threshold.direction,
      daysToExpiry
    );

    // Calculate edge
    const edge = estimatedProbability - marketOdds;

    // Determine recommendation
    let recommendation: 'BUY_YES' | 'BUY_NO' | 'NO_EDGE' = 'NO_EDGE';
    if (edge > 0.05) {
      recommendation = 'BUY_YES';
    } else if (edge < -0.05) {
      recommendation = 'BUY_NO';
    }

    // Calculate confidence
    const confidence = Math.min(95, Math.abs(edge) * 200);

    // Generate reasoning
    const reasoning = this.generateReasoning(
      coinId,
      currentPrice,
      threshold.price,
      threshold.direction,
      marketOdds,
      estimatedProbability,
      daysToExpiry
    );

    return {
      market,
      coin: coinId,
      currentPrice,
      targetPrice: threshold.price,
      priceDirection: threshold.direction,
      distancePercent,
      daysToExpiry,
      marketOdds,
      estimatedProbability,
      edge,
      recommendation,
      confidence,
      reasoning,
    };
  }

  /**
   * Estimate probability of price reaching threshold
   * Uses simple volatility-based model
   */
  private estimateProbability(
    currentPrice: number,
    targetPrice: number,
    direction: 'above' | 'below',
    daysToExpiry: number
  ): number {
    // Assumed daily volatility (can be refined with historical data)
    const dailyVolatility = 0.035; // ~3.5% daily volatility for crypto

    // Expected move over time period
    const expectedMove = dailyVolatility * Math.sqrt(daysToExpiry);

    // Distance to target as percentage
    const distance = Math.abs(targetPrice - currentPrice) / currentPrice;

    // Z-score
    const zScore = distance / expectedMove;

    // Convert to probability using normal distribution approximation
    // P(Z < z) approximation
    const probability = this.normalCDF(-zScore);

    if (direction === 'above') {
      // Probability of going above target
      if (currentPrice >= targetPrice) {
        return 0.7 + (0.25 * (1 - distance)); // Already above, high probability
      }
      return probability;
    } else {
      // Probability of going below target
      if (currentPrice <= targetPrice) {
        return 0.7 + (0.25 * (1 - distance)); // Already below, high probability
      }
      return probability;
    }
  }

  /**
   * Approximate normal CDF
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Generate reasoning for the opportunity
   */
  private generateReasoning(
    coin: string,
    currentPrice: number,
    targetPrice: number,
    direction: 'above' | 'below',
    marketOdds: number,
    estimatedProbability: number,
    daysToExpiry: number
  ): string {
    const coinName = coin.charAt(0).toUpperCase() + coin.slice(1);
    const distancePercent = ((targetPrice - currentPrice) / currentPrice * 100).toFixed(1);
    const edgePercent = ((estimatedProbability - marketOdds) * 100).toFixed(1);

    if (estimatedProbability > marketOdds) {
      return `${coinName} at $${currentPrice.toLocaleString()} needs ${direction === 'above' ? 'gain' : 'drop'} of ${Math.abs(parseFloat(distancePercent))}% to reach $${targetPrice.toLocaleString()}. ` +
             `Market prices ${(marketOdds * 100).toFixed(0)}% but volatility model suggests ${(estimatedProbability * 100).toFixed(0)}% probability over ${daysToExpiry.toFixed(0)} days. ` +
             `Edge: +${edgePercent}% - BUY YES appears underpriced.`;
    } else {
      return `${coinName} at $${currentPrice.toLocaleString()} needs ${direction === 'above' ? 'gain' : 'drop'} of ${Math.abs(parseFloat(distancePercent))}% to reach $${targetPrice.toLocaleString()}. ` +
             `Market prices ${(marketOdds * 100).toFixed(0)}% but volatility model suggests ${(estimatedProbability * 100).toFixed(0)}% probability over ${daysToExpiry.toFixed(0)} days. ` +
             `Edge: ${edgePercent}% - BUY NO appears underpriced.`;
    }
  }

  /**
   * Get top opportunities formatted for display
   */
  async getTopOpportunities(limit: number = 5): Promise<string> {
    const opportunities = await this.findOpportunities(0.05);

    if (opportunities.length === 0) {
      return 'No significant crypto price betting opportunities found at this time.';
    }

    const top = opportunities.slice(0, limit);

    let output = `CRYPTO PRICE OPPORTUNITIES (${top.length} found)\n\n`;

    for (let i = 0; i < top.length; i++) {
      const opp = top[i];
      output += `${i + 1}. ${opp.market.question.slice(0, 80)}\n`;
      output += `   ${opp.coin.toUpperCase()}: $${opp.currentPrice.toLocaleString()} → Target: $${opp.targetPrice.toLocaleString()}\n`;
      output += `   Market: ${(opp.marketOdds * 100).toFixed(0)}% | Model: ${(opp.estimatedProbability * 100).toFixed(0)}% | Edge: ${(opp.edge * 100).toFixed(1)}%\n`;
      output += `   Recommendation: ${opp.recommendation} (${opp.confidence.toFixed(0)}% confidence)\n`;
      output += `   ${opp.reasoning.slice(0, 150)}...\n\n`;
    }

    return output;
  }
}
