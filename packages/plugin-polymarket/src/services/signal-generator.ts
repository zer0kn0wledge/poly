/**
 * Signal Generator Service
 *
 * The core intelligence layer that:
 * 1. Aggregates data from all sources (news, Twitter, prices, sports)
 * 2. Matches signals to relevant Polymarket markets
 * 3. Uses LLM reasoning to generate trading signals
 * 4. Tracks signal accuracy for continuous improvement
 */

import { Service, logger, type IAgentRuntime, ModelType } from '@elizaos/core';
import { DataSourcesService, type MarketSignal, type NewsItem } from './data-sources';
import { TwitterMonitorService, type TwitterAlert } from './twitter-monitor';
import { PolymarketService } from './polymarket';
import type { PolymarketMarket } from '../types';
import { getCurrentETTime, getRelativeTimeContext } from '../providers/timezone';

export interface TradingSignal {
  id: string;
  market: PolymarketMarket;
  direction: 'BUY_YES' | 'BUY_NO' | 'HOLD';
  confidence: number; // 0-100
  edge: number; // Estimated edge in percentage points
  reasoning: string;
  supportingData: {
    news: NewsItem[];
    tweets: TwitterAlert[];
    priceSignals: MarketSignal[];
    webSignals?: MarketSignal[];
  };
  timestamp: Date;
  expiresAt: Date; // Signal validity window
  factors?: SignalFactors; // Multi-factor breakdown
}

/**
 * Multi-factor signal analysis
 */
export interface SignalFactors {
  newsScore: number; // 0-100: News sentiment impact
  socialScore: number; // 0-100: Twitter/social signal strength
  priceScore: number; // 0-100: Price momentum
  volumeScore: number; // 0-100: Market volume/liquidity
  timeDecay: number; // 0-1: Freshness of signals
  webSearchScore: number; // 0-100: Tavily real-time context
  consensusScore: number; // 0-100: Cross-source agreement
  compositeScore: number; // Weighted average of all factors
}

/**
 * Factor weights configuration
 */
const FACTOR_WEIGHTS = {
  news: 0.20, // News has moderate impact
  social: 0.15, // Social signals - often noisy
  price: 0.20, // Price momentum important for crypto
  volume: 0.10, // Volume indicates conviction
  webSearch: 0.20, // Real-time context from Tavily
  consensus: 0.15, // Cross-source agreement
};

export interface SignalPerformance {
  signalId: string;
  marketId: string;
  direction: string;
  confidence: number;
  entryPrice: number;
  currentPrice?: number;
  exitPrice?: number;
  pnl?: number;
  isCorrect?: boolean;
  createdAt: Date;
  resolvedAt?: Date;
}

export class SignalGeneratorService extends Service {
  static override readonly serviceType = 'signal-generator';
  override capabilityDescription = 'Generates trading signals from aggregated market data';

  static async start(runtime: IAgentRuntime): Promise<SignalGeneratorService> {
    const service = new SignalGeneratorService();
    await service.initialize(runtime);
    return service;
  }

  private runtime: IAgentRuntime | null = null;
  private signalHistory: TradingSignal[] = [];
  private performanceHistory: SignalPerformance[] = [];
  private readonly MAX_HISTORY = 1000;
  private readonly SIGNAL_VALIDITY_MINUTES = 30;
  private readonly SIGNAL_FRESHNESS_MINUTES = 60; // Signals older than this get time decay

  constructor() {
    super();
  }

  // ============= Multi-Factor Analysis =============

  /**
   * Calculate multi-factor signal score for a market match
   */
  private calculateFactors(match: {
    market: PolymarketMarket;
    relevantSignals: MarketSignal[];
    relevantAlerts: TwitterAlert[];
  }): SignalFactors {
    const { market, relevantSignals, relevantAlerts } = match;

    // 1. News Score - based on news sentiment and volume
    const newsSignals = relevantSignals.filter(s => s.type === 'news' || s.type === 'politics');
    const newsScore = this.calculateNewsScore(newsSignals);

    // 2. Social Score - based on Twitter signals and influencer impact
    const socialScore = this.calculateSocialScore(relevantAlerts);

    // 3. Price Score - based on price momentum signals
    const priceSignals = relevantSignals.filter(s => s.type === 'price');
    const priceScore = this.calculatePriceScore(priceSignals);

    // 4. Volume Score - based on market liquidity
    const volumeScore = this.calculateVolumeScore(market);

    // 5. Web Search Score - based on Tavily real-time context
    const webSignals = relevantSignals.filter(s => s.type === 'web');
    const webSearchScore = this.calculateWebScore(webSignals);

    // 6. Time Decay - freshness of all signals
    const timeDecay = this.calculateTimeDecay([...relevantSignals, ...relevantAlerts.map(a => ({
      timestamp: a.tweet.createdAt,
    }))]);

    // 7. Consensus Score - cross-source agreement
    const consensusScore = this.calculateConsensusScore(relevantSignals, relevantAlerts);

    // Composite Score - weighted average
    const compositeScore = Math.round(
      (newsScore * FACTOR_WEIGHTS.news +
       socialScore * FACTOR_WEIGHTS.social +
       priceScore * FACTOR_WEIGHTS.price +
       volumeScore * FACTOR_WEIGHTS.volume +
       webSearchScore * FACTOR_WEIGHTS.webSearch +
       consensusScore * FACTOR_WEIGHTS.consensus) * timeDecay
    );

    return {
      newsScore,
      socialScore,
      priceScore,
      volumeScore,
      timeDecay,
      webSearchScore,
      consensusScore,
      compositeScore,
    };
  }

  /**
   * Calculate news sentiment score
   */
  private calculateNewsScore(newsSignals: MarketSignal[]): number {
    if (newsSignals.length === 0) return 50; // Neutral if no news

    let totalScore = 0;
    let totalWeight = 0;

    for (const signal of newsSignals) {
      const weight = signal.strength / 100;
      const directionMultiplier = signal.direction === 'bullish' ? 1 : signal.direction === 'bearish' ? -1 : 0;
      totalScore += (signal.strength * directionMultiplier) * weight;
      totalWeight += weight;
    }

    // Normalize to 0-100 scale (50 is neutral)
    const normalizedScore = totalWeight > 0 ? (totalScore / totalWeight) : 0;
    return Math.max(0, Math.min(100, 50 + normalizedScore / 2));
  }

  /**
   * Calculate social/Twitter signal score
   */
  private calculateSocialScore(alerts: TwitterAlert[]): number {
    if (alerts.length === 0) return 50;

    let totalScore = 0;
    let totalWeight = 0;

    for (const alert of alerts) {
      // Weight by follower count (logarithmic scale)
      const followerWeight = Math.log10(Math.max(alert.tweet.authorFollowers, 100)) / 7; // Normalize to ~0-1
      const engagementWeight = Math.log10(Math.max(alert.tweet.likes + alert.tweet.retweets, 1)) / 5;
      const weight = (followerWeight + engagementWeight) / 2;

      const directionMultiplier = alert.sentiment === 'bullish' ? 1 : alert.sentiment === 'bearish' ? -1 : 0;
      totalScore += 100 * directionMultiplier * weight;
      totalWeight += weight;
    }

    const normalizedScore = totalWeight > 0 ? (totalScore / totalWeight) : 0;
    return Math.max(0, Math.min(100, 50 + normalizedScore / 2));
  }

  /**
   * Calculate price momentum score
   */
  private calculatePriceScore(priceSignals: MarketSignal[]): number {
    if (priceSignals.length === 0) return 50;

    let bullishCount = 0;
    let bearishCount = 0;
    let totalStrength = 0;

    for (const signal of priceSignals) {
      if (signal.direction === 'bullish') {
        bullishCount++;
        totalStrength += signal.strength;
      } else if (signal.direction === 'bearish') {
        bearishCount++;
        totalStrength += signal.strength;
      }
    }

    const total = bullishCount + bearishCount;
    if (total === 0) return 50;

    const bullishRatio = bullishCount / total;
    const avgStrength = totalStrength / total;

    // Score based on direction and strength
    return Math.max(0, Math.min(100, 50 + (bullishRatio - 0.5) * avgStrength));
  }

  /**
   * Calculate market volume/liquidity score
   */
  private calculateVolumeScore(market: PolymarketMarket): number {
    const volume = market.volume_num || 0;
    const liquidity = market.liquidity || 0;

    // Volume thresholds (in USD)
    const LOW_VOLUME = 10000;
    const MEDIUM_VOLUME = 100000;
    const HIGH_VOLUME = 1000000;

    let volumeScore: number;
    if (volume >= HIGH_VOLUME) {
      volumeScore = 90;
    } else if (volume >= MEDIUM_VOLUME) {
      volumeScore = 70 + (volume - MEDIUM_VOLUME) / (HIGH_VOLUME - MEDIUM_VOLUME) * 20;
    } else if (volume >= LOW_VOLUME) {
      volumeScore = 50 + (volume - LOW_VOLUME) / (MEDIUM_VOLUME - LOW_VOLUME) * 20;
    } else {
      volumeScore = 30 + (volume / LOW_VOLUME) * 20;
    }

    // Bonus for good liquidity (tight spread)
    const spread = market.spread || 0;
    const spreadBonus = spread < 0.02 ? 10 : spread < 0.05 ? 5 : 0;

    return Math.min(100, volumeScore + spreadBonus);
  }

  /**
   * Calculate web search (Tavily) score
   */
  private calculateWebScore(webSignals: MarketSignal[]): number {
    if (webSignals.length === 0) return 50;

    let totalScore = 0;
    for (const signal of webSignals) {
      const directionMultiplier = signal.direction === 'bullish' ? 1 : signal.direction === 'bearish' ? -1 : 0;
      totalScore += signal.strength * directionMultiplier;
    }

    const avgScore = totalScore / webSignals.length;
    return Math.max(0, Math.min(100, 50 + avgScore / 2));
  }

  /**
   * Calculate time decay based on signal freshness
   */
  private calculateTimeDecay(signals: Array<{ timestamp: Date } | { timestamp?: Date }>): number {
    if (signals.length === 0) return 0.5;

    const now = Date.now();
    let totalDecay = 0;
    let validSignals = 0;

    for (const signal of signals) {
      if (signal.timestamp) {
        const ageMinutes = (now - new Date(signal.timestamp).getTime()) / (1000 * 60);
        // Exponential decay: signals lose value over time
        const decay = Math.exp(-ageMinutes / this.SIGNAL_FRESHNESS_MINUTES);
        totalDecay += decay;
        validSignals++;
      }
    }

    return validSignals > 0 ? totalDecay / validSignals : 0.5;
  }

  /**
   * Calculate consensus score - how much sources agree
   */
  private calculateConsensusScore(signals: MarketSignal[], alerts: TwitterAlert[]): number {
    const directions: ('bullish' | 'bearish' | 'neutral')[] = [];

    for (const signal of signals) {
      directions.push(signal.direction);
    }

    for (const alert of alerts) {
      directions.push(alert.sentiment);
    }

    if (directions.length === 0) return 50;

    const bullish = directions.filter(d => d === 'bullish').length;
    const bearish = directions.filter(d => d === 'bearish').length;
    const total = bullish + bearish;

    if (total === 0) return 50; // All neutral

    // High consensus = most signals agree on direction
    const dominantCount = Math.max(bullish, bearish);
    const consensusRatio = dominantCount / total;

    // Scale from 50 (no consensus) to 100 (full consensus)
    return Math.round(50 + consensusRatio * 50);
  }


  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[SignalGenerator] Initializing signal generator service');
    this.runtime = runtime;
  }

  override async stop(): Promise<void> {
    logger.info('[SignalGenerator] Stopping signal generator service');
    this.signalHistory = [];
  }

  // ============= Main Signal Generation =============

  async generateSignals(): Promise<TradingSignal[]> {
    if (!this.runtime) {
      logger.error('[SignalGenerator] Runtime not initialized');
      return [];
    }

    // Get current date/time context
    const etTime = getCurrentETTime();
    logger.info('[SignalGenerator] Starting signal generation cycle', {
      currentDate: etTime.dateStr,
      currentTime: etTime.timeStr,
      timezone: 'ET',
      currentYear: etTime.year,
    });

    // Get services
    const dataService = this.runtime.getService<DataSourcesService>('data-sources');
    const twitterService = this.runtime.getService<TwitterMonitorService>('twitter-monitor');
    const polymarketService = this.runtime.getService<PolymarketService>('polymarket');

    if (!polymarketService) {
      logger.error('[SignalGenerator] Polymarket service not available');
      return [];
    }

    // Gather all data in parallel
    const [rawMarkets, marketSignals, twitterAlerts] = await Promise.all([
      polymarketService.getMarkets({ active: true, limit: 30 }),
      dataService?.getMarketSignals() || [],
      twitterService?.scanForAlerts(['crypto', 'politics', 'sports']) || [],
    ]);

    // Filter out closed/archived markets only - trust the API's closed flag
    // Don't filter by end_date or year in question - markets can be open after end date (awaiting resolution)
    const markets = rawMarkets.filter((market) => {
      // Trust API's closed flag - if it says closed=false, it's tradeable
      if (market.closed) {
        logger.debug({ market: market.question }, '[SignalGenerator] Skipping closed market');
        return false;
      }

      if (market.archived) {
        logger.debug({ market: market.question }, '[SignalGenerator] Skipping archived market');
        return false;
      }

      return true;
    });

    logger.info('[SignalGenerator] Data gathered:', {
      rawMarkets: rawMarkets.length,
      validMarkets: markets.length,
      expiredFiltered: rawMarkets.length - markets.length,
      signals: marketSignals.length,
      alerts: twitterAlerts.length,
    });

    // Match signals to markets
    const matchedSignals = this.matchSignalsToMarkets(markets, marketSignals, twitterAlerts);

    // Calculate multi-factor scores for each match
    const scoredMatches = matchedSignals.map(match => ({
      ...match,
      factors: this.calculateFactors(match),
    }));

    // Sort by composite score (highest first)
    scoredMatches.sort((a, b) => b.factors.compositeScore - a.factors.compositeScore);

    logger.info('[SignalGenerator] Top matches by composite score:',
      scoredMatches.slice(0, 5).map(m => ({
        market: m.market.question.slice(0, 50),
        composite: m.factors.compositeScore,
        news: m.factors.newsScore,
        social: m.factors.socialScore,
        web: m.factors.webSearchScore,
        consensus: m.factors.consensusScore,
      }))
    );

    // Generate trading signals using LLM - prioritize high-scoring matches
    const tradingSignals: TradingSignal[] = [];

    // Only analyze top matches with decent composite scores
    const worthyMatches = scoredMatches.filter(m =>
      m.factors.compositeScore >= 40 && // Minimum threshold
      (m.relevantSignals.length > 0 || m.relevantAlerts.length > 0)
    ).slice(0, 10); // Limit to top 10 to avoid excessive LLM calls

    for (const match of worthyMatches) {
      try {
        const signal = await this.analyzeMarketWithLLM(match);
        if (signal && signal.confidence >= 60) {
          // Attach multi-factor analysis to signal
          signal.factors = match.factors;

          // Adjust confidence based on factor consensus
          const factorConfidenceBoost = (match.factors.consensusScore - 50) * 0.2;
          signal.confidence = Math.min(100, Math.round(signal.confidence + factorConfidenceBoost));

          tradingSignals.push(signal);
        }
      } catch (error) {
        logger.error({ error, market: match.market.question }, '[SignalGenerator] LLM analysis failed');
      }
    }

    // Store signals
    this.signalHistory = [...tradingSignals, ...this.signalHistory].slice(0, this.MAX_HISTORY);

    logger.info('[SignalGenerator] Generated signals:', {
      count: tradingSignals.length,
      avgConfidence: tradingSignals.length > 0
        ? Math.round(tradingSignals.reduce((s, t) => s + t.confidence, 0) / tradingSignals.length)
        : 0,
      avgComposite: tradingSignals.length > 0
        ? Math.round(tradingSignals.reduce((s, t) => s + (t.factors?.compositeScore || 0), 0) / tradingSignals.length)
        : 0,
    });

    return tradingSignals;
  }

  private matchSignalsToMarkets(
    markets: PolymarketMarket[],
    signals: MarketSignal[],
    alerts: TwitterAlert[]
  ): Array<{
    market: PolymarketMarket;
    relevantSignals: MarketSignal[];
    relevantAlerts: TwitterAlert[];
  }> {
    const matches: Array<{
      market: PolymarketMarket;
      relevantSignals: MarketSignal[];
      relevantAlerts: TwitterAlert[];
    }> = [];

    for (const market of markets) {
      const marketKeywords = this.extractMarketKeywords(market.question);

      // Find relevant signals
      const relevantSignals = signals.filter((signal) =>
        this.hasOverlap(signal.relatedMarkets, marketKeywords) ||
        marketKeywords.some((kw) => signal.summary.toLowerCase().includes(kw.toLowerCase()))
      );

      // Find relevant alerts
      const relevantAlerts = alerts.filter((alert) =>
        this.hasOverlap(alert.inferredMarkets, marketKeywords) ||
        marketKeywords.some((kw) => alert.tweet.text.toLowerCase().includes(kw.toLowerCase()))
      );

      if (relevantSignals.length > 0 || relevantAlerts.length > 0) {
        matches.push({
          market,
          relevantSignals: relevantSignals.slice(0, 10),
          relevantAlerts: relevantAlerts.slice(0, 10),
        });
      }
    }

    // Sort by total signal count
    return matches.sort(
      (a, b) =>
        b.relevantSignals.length + b.relevantAlerts.length -
        (a.relevantSignals.length + a.relevantAlerts.length)
    );
  }

  private extractMarketKeywords(question: string): string[] {
    const keywords: string[] = [];
    const lowerQuestion = question.toLowerCase();

    // Common entities
    const entities = [
      'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'crypto',
      'trump', 'biden', 'harris', 'desantis', 'republican', 'democrat',
      'election', 'president', 'congress', 'senate',
      'fed', 'interest rate', 'inflation', 'recession',
      'super bowl', 'nba', 'nfl', 'world cup', 'olympics',
      'tesla', 'apple', 'google', 'microsoft', 'amazon',
      'ukraine', 'russia', 'china', 'israel', 'gaza'
    ];

    for (const entity of entities) {
      if (lowerQuestion.includes(entity)) {
        keywords.push(entity);
      }
    }

    // Extract capitalized words (likely proper nouns)
    const properNouns = question.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) || [];
    keywords.push(...properNouns.map((n) => n.toLowerCase()));

    return [...new Set(keywords)];
  }

  private hasOverlap(arr1: string[], arr2: string[]): boolean {
    const set1 = new Set(arr1.map((s) => s.toLowerCase()));
    return arr2.some((item) => set1.has(item.toLowerCase()));
  }

  // ============= LLM Analysis =============

  private async analyzeMarketWithLLM(match: {
    market: PolymarketMarket;
    relevantSignals: MarketSignal[];
    relevantAlerts: TwitterAlert[];
    factors?: SignalFactors;
  }): Promise<TradingSignal | null> {
    if (!this.runtime) return null;

    const { market, relevantSignals, relevantAlerts, factors } = match;

    // Get current date/time context
    const etTime = getCurrentETTime();

    // Get current price
    const yesToken = market.tokens.find((t) => t.outcome.toLowerCase() === 'yes');
    const currentYesPrice = yesToken?.price || 0.5;

    // Calculate time until market resolution
    const timeContext = market.end_date_iso
      ? getRelativeTimeContext(new Date(market.end_date_iso))
      : 'Unknown end date';

    // Format data for LLM
    const newsContext = relevantSignals
      .filter((s) => s.type === 'news' || s.type === 'politics')
      .map((s) => `- [${s.source}] ${s.summary} (${s.direction}, strength: ${s.strength})`)
      .join('\n');

    const twitterContext = relevantAlerts
      .map((a) => `- @${a.tweet.authorUsername} (${a.tweet.authorFollowers.toLocaleString()} followers): "${a.tweet.text.slice(0, 200)}" [${a.sentiment}]`)
      .join('\n');

    const priceContext = relevantSignals
      .filter((s) => s.type === 'price')
      .map((s) => `- ${s.summary} (strength: ${s.strength})`)
      .join('\n');

    // Web search context from Tavily
    const webContext = relevantSignals
      .filter((s) => s.type === 'web')
      .map((s) => `- [Tavily] ${s.summary} (${s.direction}, confidence: ${s.strength}%)`)
      .join('\n');

    // Multi-factor analysis summary
    const factorSummary = factors ? `
MULTI-FACTOR ANALYSIS (Pre-computed scores):
- News Sentiment Score: ${factors.newsScore}/100 ${factors.newsScore > 60 ? '(bullish)' : factors.newsScore < 40 ? '(bearish)' : '(neutral)'}
- Social Signal Score: ${factors.socialScore}/100
- Price Momentum Score: ${factors.priceScore}/100
- Volume/Liquidity Score: ${factors.volumeScore}/100
- Web Search Score: ${factors.webSearchScore}/100
- Cross-Source Consensus: ${factors.consensusScore}/100 ${factors.consensusScore > 70 ? '(HIGH AGREEMENT)' : factors.consensusScore < 50 ? '(MIXED SIGNALS)' : ''}
- Signal Freshness: ${(factors.timeDecay * 100).toFixed(0)}%
- COMPOSITE SCORE: ${factors.compositeScore}/100` : '';

    const prompt = `You are an expert prediction market trader. Analyze this market and determine if there's a trading opportunity.

CURRENT DATE/TIME CONTEXT:
- Today: ${etTime.dayOfWeek}, ${etTime.dateStr}
- Time: ${etTime.timeStr} ET (US Eastern Time)
- Current Year: ${etTime.year}
- This is critical: Any market referencing years before ${etTime.year} has already resolved or expired.

MARKET: "${market.question}"
Current YES price: ${(currentYesPrice * 100).toFixed(1)}% (NO: ${((1 - currentYesPrice) * 100).toFixed(1)}%)
Volume: $${market.volume_num?.toLocaleString() || 'N/A'}
Liquidity: $${market.liquidity?.toLocaleString() || 'N/A'}
Spread: ${((market.spread || 0) * 100).toFixed(1)}%
End Date: ${market.end_date_iso || 'Unknown'}
Time Until Resolution: ${timeContext}
${factorSummary}

RECENT NEWS:
${newsContext || 'No relevant news'}

WEB SEARCH CONTEXT (Real-time):
${webContext || 'No web search results'}

TWITTER SIGNALS:
${twitterContext || 'No relevant tweets'}

PRICE MOVEMENTS:
${priceContext || 'No significant price movements'}

ANALYSIS REQUIRED:
1. First, verify the market is still relevant given today's date (${etTime.dateStr})
2. Review the multi-factor scores above - high consensus (>70) with multiple bullish/bearish factors suggests stronger edge
3. Based on ALL data above, what is your estimated TRUE probability of YES?
4. Is there meaningful edge (>10% difference from current price)?
5. Consider signal freshness - older signals are less reliable

Respond with JSON:
{
  "estimatedProbability": 0.XX,
  "direction": "BUY_YES" | "BUY_NO" | "HOLD",
  "confidence": 0-100,
  "edge": percentage points of estimated edge,
  "reasoning": "Clear explanation citing specific data points, factor scores, and considering current date context"
}

TRADING GUIDELINES:
- Require consensus score >60 for high confidence trades
- Prioritize fresh signals (time decay >70%)
- Volume score <50 means thin liquidity - be cautious with size
- Only recommend trades with clear edge (>10%) supported by multiple data sources
- If the market references past events or dates, return HOLD with 0 confidence.`;

    try {
      const response = await this.runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt,
        schema: {
          type: 'object',
          properties: {
            estimatedProbability: { type: 'number' },
            direction: { type: 'string' },
            confidence: { type: 'number' },
            edge: { type: 'number' },
            reasoning: { type: 'string' },
          },
          required: ['estimatedProbability', 'direction', 'confidence', 'edge', 'reasoning'],
        },
      });

      if (!response || typeof response !== 'object') {
        return null;
      }

      const analysis = response as any;

      // Validate response
      if (
        analysis.direction === 'HOLD' ||
        analysis.confidence < 60 ||
        Math.abs(analysis.edge) < 10
      ) {
        return null;
      }

      return {
        id: crypto.randomUUID(),
        market,
        direction: analysis.direction,
        confidence: analysis.confidence,
        edge: analysis.edge,
        reasoning: analysis.reasoning,
        supportingData: {
          news: relevantSignals.filter((s) => s.type === 'news').map((s) => s.rawData as NewsItem),
          tweets: relevantAlerts,
          priceSignals: relevantSignals.filter((s) => s.type === 'price'),
          webSignals: relevantSignals.filter((s) => s.type === 'web'),
        },
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + this.SIGNAL_VALIDITY_MINUTES * 60 * 1000),
        factors, // Attach multi-factor breakdown
      };
    } catch (error) {
      logger.error({ error }, '[SignalGenerator] LLM analysis failed');
      return null;
    }
  }

  // ============= Performance Tracking =============

  recordSignalEntry(signal: TradingSignal, entryPrice: number): void {
    this.performanceHistory.push({
      signalId: signal.id,
      marketId: signal.market.condition_id,
      direction: signal.direction,
      confidence: signal.confidence,
      entryPrice,
      createdAt: new Date(),
    });

    // Trim history
    if (this.performanceHistory.length > this.MAX_HISTORY) {
      this.performanceHistory = this.performanceHistory.slice(-this.MAX_HISTORY);
    }
  }

  updateSignalPerformance(signalId: string, currentPrice: number): void {
    const perf = this.performanceHistory.find((p) => p.signalId === signalId);
    if (perf) {
      perf.currentPrice = currentPrice;
      // Calculate unrealized P&L
      if (perf.direction === 'BUY_YES') {
        perf.pnl = (currentPrice - perf.entryPrice) / perf.entryPrice * 100;
      } else if (perf.direction === 'BUY_NO') {
        perf.pnl = ((1 - currentPrice) - (1 - perf.entryPrice)) / (1 - perf.entryPrice) * 100;
      }
    }
  }

  closeSignal(signalId: string, exitPrice: number, isCorrect: boolean): void {
    const perf = this.performanceHistory.find((p) => p.signalId === signalId);
    if (perf) {
      perf.exitPrice = exitPrice;
      perf.isCorrect = isCorrect;
      perf.resolvedAt = new Date();

      // Calculate final P&L
      if (perf.direction === 'BUY_YES') {
        perf.pnl = (exitPrice - perf.entryPrice) / perf.entryPrice * 100;
      } else if (perf.direction === 'BUY_NO') {
        perf.pnl = ((1 - exitPrice) - (1 - perf.entryPrice)) / (1 - perf.entryPrice) * 100;
      }
    }
  }

  getPerformanceStats(): {
    totalSignals: number;
    winRate: number;
    avgPnl: number;
    avgConfidence: number;
    profitFactor: number;
  } {
    const resolved = this.performanceHistory.filter((p) => p.resolvedAt);

    if (resolved.length === 0) {
      return {
        totalSignals: 0,
        winRate: 0,
        avgPnl: 0,
        avgConfidence: 0,
        profitFactor: 0,
      };
    }

    const wins = resolved.filter((p) => p.isCorrect);
    const winPnl = wins.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const lossPnl = Math.abs(
      resolved
        .filter((p) => !p.isCorrect)
        .reduce((sum, p) => sum + (p.pnl || 0), 0)
    );

    return {
      totalSignals: resolved.length,
      winRate: (wins.length / resolved.length) * 100,
      avgPnl: resolved.reduce((sum, p) => sum + (p.pnl || 0), 0) / resolved.length,
      avgConfidence:
        resolved.reduce((sum, p) => sum + p.confidence, 0) / resolved.length,
      profitFactor: lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? Infinity : 0,
    };
  }

  // ============= Public Getters =============

  getActiveSignals(): TradingSignal[] {
    const now = Date.now();
    return this.signalHistory.filter((s) => s.expiresAt.getTime() > now);
  }

  getSignalById(id: string): TradingSignal | undefined {
    return this.signalHistory.find((s) => s.id === id);
  }

  getSignalsByMarket(marketId: string): TradingSignal[] {
    return this.signalHistory.filter((s) => s.market.condition_id === marketId);
  }

  getHighConfidenceSignals(minConfidence: number = 75): TradingSignal[] {
    return this.getActiveSignals().filter((s) => s.confidence >= minConfidence);
  }
}
