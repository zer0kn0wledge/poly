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
  };
  timestamp: Date;
  expiresAt: Date; // Signal validity window
}

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

  constructor() {
    super();
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

    logger.info('[SignalGenerator] Starting signal generation cycle');

    // Get services
    const dataService = this.runtime.getService<DataSourcesService>('data-sources');
    const twitterService = this.runtime.getService<TwitterMonitorService>('twitter-monitor');
    const polymarketService = this.runtime.getService<PolymarketService>('polymarket');

    if (!polymarketService) {
      logger.error('[SignalGenerator] Polymarket service not available');
      return [];
    }

    // Gather all data in parallel
    const [markets, marketSignals, twitterAlerts] = await Promise.all([
      polymarketService.getMarkets({ active: true, limit: 30 }),
      dataService?.getMarketSignals() || [],
      twitterService?.scanForAlerts(['crypto', 'politics', 'sports']) || [],
    ]);

    logger.info('[SignalGenerator] Data gathered:', {
      markets: markets.length,
      signals: marketSignals.length,
      alerts: twitterAlerts.length,
    });

    // Match signals to markets
    const matchedSignals = this.matchSignalsToMarkets(markets, marketSignals, twitterAlerts);

    // Generate trading signals using LLM
    const tradingSignals: TradingSignal[] = [];

    for (const match of matchedSignals) {
      if (match.relevantSignals.length === 0 && match.relevantAlerts.length === 0) {
        continue;
      }

      try {
        const signal = await this.analyzeMarketWithLLM(match);
        if (signal && signal.confidence >= 60) {
          tradingSignals.push(signal);
        }
      } catch (error) {
        logger.error({ error, market: match.market.question }, '[SignalGenerator] LLM analysis failed');
      }
    }

    // Store signals
    this.signalHistory = [...tradingSignals, ...this.signalHistory].slice(0, this.MAX_HISTORY);

    logger.info('[SignalGenerator] Generated signals:', tradingSignals.length);

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
  }): Promise<TradingSignal | null> {
    if (!this.runtime) return null;

    const { market, relevantSignals, relevantAlerts } = match;

    // Get current price
    const yesToken = market.tokens.find((t) => t.outcome.toLowerCase() === 'yes');
    const currentYesPrice = yesToken?.price || 0.5;

    // Format data for LLM
    const newsContext = relevantSignals
      .filter((s) => s.type === 'news' || s.type === 'politics')
      .map((s) => `- [${s.source}] ${s.summary} (${s.direction})`)
      .join('\n');

    const twitterContext = relevantAlerts
      .map((a) => `- @${a.tweet.authorUsername} (${a.tweet.authorFollowers.toLocaleString()} followers): "${a.tweet.text.slice(0, 200)}" [${a.sentiment}]`)
      .join('\n');

    const priceContext = relevantSignals
      .filter((s) => s.type === 'price')
      .map((s) => `- ${s.summary}`)
      .join('\n');

    const prompt = `You are an expert prediction market trader. Analyze this market and determine if there's a trading opportunity.

MARKET: "${market.question}"
Current YES price: ${(currentYesPrice * 100).toFixed(1)}% (NO: ${((1 - currentYesPrice) * 100).toFixed(1)}%)
Volume: $${market.volume_num?.toLocaleString() || 'N/A'}
End Date: ${market.end_date_iso || 'Unknown'}

RECENT NEWS:
${newsContext || 'No relevant news'}

TWITTER SIGNALS:
${twitterContext || 'No relevant tweets'}

PRICE MOVEMENTS:
${priceContext || 'No significant price movements'}

ANALYSIS REQUIRED:
1. Based on the data above, what is your estimated TRUE probability of YES?
2. Is there meaningful edge (>10% difference from current price)?
3. What is your confidence in this analysis?

Respond with JSON:
{
  "estimatedProbability": 0.XX,
  "direction": "BUY_YES" | "BUY_NO" | "HOLD",
  "confidence": 0-100,
  "edge": percentage points of estimated edge,
  "reasoning": "Clear explanation citing specific data points"
}

Be conservative. Only recommend trades with clear edge supported by multiple data points.`;

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
        },
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + this.SIGNAL_VALIDITY_MINUTES * 60 * 1000),
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
