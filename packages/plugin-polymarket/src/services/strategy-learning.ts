/**
 * Strategy Learning Service
 *
 * Tracks trading performance and learns from historical data to improve strategies.
 * Key features:
 * - Tracks all trades with entry/exit data
 * - Correlates data sources/indicators with returns
 * - Identifies successful strategy patterns
 * - Adjusts strategy weights over time
 * - Provides performance analytics
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { getCurrentETTime } from '../providers/timezone';

// ============= Types =============

export interface TradeRecord {
  id: string;
  marketId: string;
  marketQuestion: string;
  direction: 'BUY_YES' | 'BUY_NO';
  entryPrice: number;
  entryTime: Date;
  exitPrice?: number;
  exitTime?: Date;
  size: number;
  pnl?: number;
  pnlPercent?: number;
  resolved: boolean;
  outcome?: 'WIN' | 'LOSS' | 'PUSH';
  // Data sources that influenced this trade
  dataSignals: DataSignalRecord[];
  // Reasoning at entry
  entryReasoning: string;
  // Post-mortem analysis
  postMortem?: string;
}

export interface DataSignalRecord {
  source: string; // e.g., 'CryptoPanic', 'Twitter', 'CoinGecko', 'NewsRSS'
  type: string; // e.g., 'news', 'price', 'social', 'sentiment'
  signal: string; // The actual signal content
  sentiment: 'bullish' | 'bearish' | 'neutral';
  strength: number; // 0-100
  timestamp: Date;
}

export interface StrategyPerformance {
  strategyId: string;
  name: string;
  description: string;
  totalTrades: number;
  winRate: number;
  avgPnl: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  lastUpdated: Date;
}

export interface DataSourcePerformance {
  source: string;
  type: string;
  tradeCount: number;
  winRate: number;
  avgPnlWhenUsed: number;
  avgPnlWhenIgnored: number;
  predictiveValue: number; // Calculated edge when using this source
  lastUpdated: Date;
}

export interface MarketSnapshot {
  marketId: string;
  question: string;
  timestamp: Date;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  volumeTotal: number;
}

export interface DailyStats {
  date: string;
  tradesOpened: number;
  tradesClosed: number;
  realizedPnl: number;
  unrealizedPnl: number;
  winRate: number;
  topWinner?: { market: string; pnl: number };
  topLoser?: { market: string; pnl: number };
}

export interface WeeklyStats {
  weekStart: string;
  weekEnd: string;
  totalTrades: number;
  closedTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnl: number;
  avgTradeSize: number;
  bestTrade: TradeRecord | null;
  worstTrade: TradeRecord | null;
  topDataSources: DataSourcePerformance[];
  lessonsLearned: string[];
}

// ============= Service Implementation =============

export class StrategyLearningService extends Service {
  static override readonly serviceType = 'strategy-learning';
  override capabilityDescription = 'Tracks and learns from trading performance';

  static async start(runtime: IAgentRuntime): Promise<StrategyLearningService> {
    const service = new StrategyLearningService();
    await service.initialize(runtime);
    return service;
  }

  private runtime: IAgentRuntime | null = null;
  private trades: Map<string, TradeRecord> = new Map();
  private marketSnapshots: Map<string, MarketSnapshot[]> = new Map();
  private dataSourcePerformance: Map<string, DataSourcePerformance> = new Map();
  private dailyStats: Map<string, DailyStats> = new Map();

  private readonly MAX_SNAPSHOTS_PER_MARKET = 1000;
  private readonly MAX_TRADES = 10000;

  constructor() {
    super();
  }

  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[StrategyLearning] Initializing strategy learning service');
    this.runtime = runtime;

    // Try to load persisted data from cache
    await this.loadPersistedData();
  }

  override async stop(): Promise<void> {
    logger.info('[StrategyLearning] Stopping strategy learning service');
    // Persist data before shutdown
    await this.persistData();
  }

  // ============= Trade Recording =============

  /**
   * Record a new trade entry
   */
  recordTradeEntry(params: {
    marketId: string;
    marketQuestion: string;
    direction: 'BUY_YES' | 'BUY_NO';
    entryPrice: number;
    size: number;
    dataSignals: DataSignalRecord[];
    reasoning: string;
  }): string {
    const tradeId = crypto.randomUUID();
    const etTime = getCurrentETTime();

    const trade: TradeRecord = {
      id: tradeId,
      marketId: params.marketId,
      marketQuestion: params.marketQuestion,
      direction: params.direction,
      entryPrice: params.entryPrice,
      entryTime: etTime.date,
      size: params.size,
      resolved: false,
      dataSignals: params.dataSignals,
      entryReasoning: params.reasoning,
    };

    this.trades.set(tradeId, trade);

    // Update daily stats
    this.updateDailyStats(etTime.dateStr, { tradesOpened: 1 });

    logger.info({
      tradeId,
      market: params.marketQuestion.slice(0, 50),
      direction: params.direction,
      price: params.entryPrice,
      signalCount: params.dataSignals.length,
    }, '[StrategyLearning] Trade entry recorded');

    // Trim old trades if needed
    this.trimOldTrades();

    return tradeId;
  }

  /**
   * Record a trade exit
   */
  recordTradeExit(tradeId: string, exitPrice: number, postMortem?: string): void {
    const trade = this.trades.get(tradeId);
    if (!trade) {
      logger.warn({ tradeId }, '[StrategyLearning] Trade not found for exit');
      return;
    }

    const etTime = getCurrentETTime();
    trade.exitPrice = exitPrice;
    trade.exitTime = etTime.date;
    trade.resolved = true;

    // Calculate P&L
    if (trade.direction === 'BUY_YES') {
      trade.pnl = (exitPrice - trade.entryPrice) * trade.size;
      trade.pnlPercent = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
    } else {
      // For BUY_NO, profit when price goes down
      trade.pnl = (trade.entryPrice - exitPrice) * trade.size;
      trade.pnlPercent = ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;
    }

    trade.outcome = trade.pnl > 0 ? 'WIN' : trade.pnl < 0 ? 'LOSS' : 'PUSH';
    trade.postMortem = postMortem;

    // Update data source performance
    this.updateDataSourcePerformance(trade);

    // Update daily stats
    this.updateDailyStats(etTime.dateStr, {
      tradesClosed: 1,
      realizedPnl: trade.pnl,
      isWin: trade.outcome === 'WIN',
    });

    logger.info({
      tradeId,
      market: trade.marketQuestion.slice(0, 50),
      pnl: trade.pnl?.toFixed(2),
      pnlPercent: trade.pnlPercent?.toFixed(1),
      outcome: trade.outcome,
    }, '[StrategyLearning] Trade exit recorded');
  }

  /**
   * Record market resolution (for unexited positions)
   */
  recordMarketResolution(marketId: string, resolvedYes: boolean): void {
    for (const trade of this.trades.values()) {
      if (trade.marketId === marketId && !trade.resolved) {
        const exitPrice = resolvedYes ? 1.0 : 0.0;
        this.recordTradeExit(
          trade.id,
          trade.direction === 'BUY_YES' ? exitPrice : (1 - exitPrice),
          `Market resolved: ${resolvedYes ? 'YES' : 'NO'}`
        );
      }
    }
  }

  // ============= Market Snapshots =============

  /**
   * Record a market snapshot for tracking price/volume changes
   */
  recordMarketSnapshot(snapshot: MarketSnapshot): void {
    const existing = this.marketSnapshots.get(snapshot.marketId) || [];
    existing.push(snapshot);

    // Trim to max snapshots
    if (existing.length > this.MAX_SNAPSHOTS_PER_MARKET) {
      existing.splice(0, existing.length - this.MAX_SNAPSHOTS_PER_MARKET);
    }

    this.marketSnapshots.set(snapshot.marketId, existing);
  }

  /**
   * Get historical snapshots for a market
   */
  getMarketHistory(marketId: string): MarketSnapshot[] {
    return this.marketSnapshots.get(marketId) || [];
  }

  /**
   * Calculate price change over period
   */
  getPriceChange(marketId: string, hoursAgo: number): { priceChange: number; volumeChange: number } | null {
    const history = this.marketSnapshots.get(marketId);
    if (!history || history.length < 2) return null;

    const now = Date.now();
    const cutoff = now - hoursAgo * 60 * 60 * 1000;

    const recent = history[history.length - 1];
    const older = history.find((s) => s.timestamp.getTime() <= cutoff);

    if (!older) return null;

    return {
      priceChange: recent.yesPrice - older.yesPrice,
      volumeChange: recent.volume24h - older.volume24h,
    };
  }

  // ============= Performance Analytics =============

  /**
   * Update data source performance based on trade outcome
   */
  private updateDataSourcePerformance(trade: TradeRecord): void {
    for (const signal of trade.dataSignals) {
      const key = `${signal.source}:${signal.type}`;
      const existing = this.dataSourcePerformance.get(key) || {
        source: signal.source,
        type: signal.type,
        tradeCount: 0,
        winRate: 0,
        avgPnlWhenUsed: 0,
        avgPnlWhenIgnored: 0,
        predictiveValue: 0,
        lastUpdated: new Date(),
      };

      // Update stats
      const prevTotal = existing.tradeCount * existing.avgPnlWhenUsed;
      existing.tradeCount += 1;
      existing.avgPnlWhenUsed = (prevTotal + (trade.pnl || 0)) / existing.tradeCount;

      // Update win rate
      const prevWins = Math.round(existing.winRate * (existing.tradeCount - 1) / 100);
      const newWins = prevWins + (trade.outcome === 'WIN' ? 1 : 0);
      existing.winRate = (newWins / existing.tradeCount) * 100;

      existing.lastUpdated = new Date();
      this.dataSourcePerformance.set(key, existing);
    }
  }

  /**
   * Update daily stats
   */
  private updateDailyStats(
    dateStr: string,
    update: {
      tradesOpened?: number;
      tradesClosed?: number;
      realizedPnl?: number;
      isWin?: boolean;
    }
  ): void {
    const existing = this.dailyStats.get(dateStr) || {
      date: dateStr,
      tradesOpened: 0,
      tradesClosed: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      winRate: 0,
    };

    if (update.tradesOpened) existing.tradesOpened += update.tradesOpened;
    if (update.tradesClosed) existing.tradesClosed += update.tradesClosed;
    if (update.realizedPnl) existing.realizedPnl += update.realizedPnl;

    // Recalculate win rate
    if (existing.tradesClosed > 0) {
      const trades = Array.from(this.trades.values()).filter(
        (t) => t.resolved && t.exitTime && this.getDateStr(t.exitTime) === dateStr
      );
      const wins = trades.filter((t) => t.outcome === 'WIN').length;
      existing.winRate = (wins / trades.length) * 100;
    }

    this.dailyStats.set(dateStr, existing);
  }

  /**
   * Get daily stats for a date
   */
  getDailyStats(dateStr: string): DailyStats | null {
    return this.dailyStats.get(dateStr) || null;
  }

  /**
   * Get weekly stats
   */
  getWeeklyStats(weekStartDate?: Date): WeeklyStats {
    const etTime = getCurrentETTime();
    const startDate = weekStartDate || this.getWeekStart(etTime.date);
    const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const weekTrades = Array.from(this.trades.values()).filter((t) => {
      const tradeDate = t.exitTime || t.entryTime;
      return tradeDate >= startDate && tradeDate < endDate;
    });

    const closedTrades = weekTrades.filter((t) => t.resolved);
    const wins = closedTrades.filter((t) => t.outcome === 'WIN');
    const losses = closedTrades.filter((t) => t.outcome === 'LOSS');

    // Sort by P&L
    const sortedByPnl = [...closedTrades].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
    const bestTrade = sortedByPnl[0] || null;
    const worstTrade = sortedByPnl[sortedByPnl.length - 1] || null;

    // Get top data sources for the week
    const weekDataSources = new Map<string, { source: string; type: string; wins: number; total: number; pnl: number }>();
    for (const trade of closedTrades) {
      for (const signal of trade.dataSignals) {
        const key = `${signal.source}:${signal.type}`;
        const existing = weekDataSources.get(key) || { source: signal.source, type: signal.type, wins: 0, total: 0, pnl: 0 };
        existing.total += 1;
        existing.pnl += trade.pnl || 0;
        if (trade.outcome === 'WIN') existing.wins += 1;
        weekDataSources.set(key, existing);
      }
    }

    const topDataSources: DataSourcePerformance[] = Array.from(weekDataSources.values())
      .map((s) => ({
        source: s.source,
        type: s.type,
        tradeCount: s.total,
        winRate: (s.wins / s.total) * 100,
        avgPnlWhenUsed: s.pnl / s.total,
        avgPnlWhenIgnored: 0,
        predictiveValue: (s.wins / s.total) * (s.pnl / s.total),
        lastUpdated: new Date(),
      }))
      .sort((a, b) => b.predictiveValue - a.predictiveValue)
      .slice(0, 5);

    // Generate lessons learned
    const lessonsLearned = this.generateLessonsLearned(closedTrades, topDataSources);

    return {
      weekStart: this.getDateStr(startDate),
      weekEnd: this.getDateStr(endDate),
      totalTrades: weekTrades.length,
      closedTrades: closedTrades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0,
      totalPnl: closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0),
      avgTradeSize: weekTrades.length > 0 ? weekTrades.reduce((sum, t) => sum + t.size, 0) / weekTrades.length : 0,
      bestTrade,
      worstTrade,
      topDataSources,
      lessonsLearned,
    };
  }

  /**
   * Generate lessons learned from trade analysis
   */
  private generateLessonsLearned(trades: TradeRecord[], topSources: DataSourcePerformance[]): string[] {
    const lessons: string[] = [];

    if (trades.length === 0) {
      lessons.push('No trades closed this week - need more market activity.');
      return lessons;
    }

    const winRate = trades.filter((t) => t.outcome === 'WIN').length / trades.length;
    const avgPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0) / trades.length;

    // Win rate insights
    if (winRate > 0.6) {
      lessons.push(`Strong week with ${(winRate * 100).toFixed(0)}% win rate - current strategy is working.`);
    } else if (winRate < 0.4) {
      lessons.push(`Win rate of ${(winRate * 100).toFixed(0)}% suggests need to tighten entry criteria.`);
    }

    // Data source insights
    if (topSources.length > 0) {
      const bestSource = topSources[0];
      if (bestSource.winRate > 60) {
        lessons.push(`${bestSource.source} signals showing ${bestSource.winRate.toFixed(0)}% accuracy - lean into this source.`);
      }
    }

    // P&L insights
    if (avgPnl > 0) {
      lessons.push(`Positive average P&L of $${avgPnl.toFixed(2)} per trade - position sizing is appropriate.`);
    } else {
      lessons.push(`Negative average P&L of $${avgPnl.toFixed(2)} - consider reducing position sizes.`);
    }

    // Loss analysis
    const losses = trades.filter((t) => t.outcome === 'LOSS');
    if (losses.length > 0) {
      const avgLoss = losses.reduce((sum, t) => sum + Math.abs(t.pnl || 0), 0) / losses.length;
      const wins = trades.filter((t) => t.outcome === 'WIN');
      const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + (t.pnl || 0), 0) / wins.length : 0;

      if (avgWin > 0 && avgLoss > avgWin * 1.5) {
        lessons.push('Average loss exceeds average win by 50%+ - need tighter stop losses.');
      }
    }

    return lessons;
  }

  /**
   * Get overall performance stats
   */
  getOverallStats(): {
    totalTrades: number;
    closedTrades: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    profitFactor: number;
    bestDataSources: DataSourcePerformance[];
  } {
    const allTrades = Array.from(this.trades.values());
    const closedTrades = allTrades.filter((t) => t.resolved);
    const wins = closedTrades.filter((t) => t.outcome === 'WIN');
    const losses = closedTrades.filter((t) => t.outcome === 'LOSS');

    const totalWinPnl = wins.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalLossPnl = Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0));
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    const bestDataSources = Array.from(this.dataSourcePerformance.values())
      .filter((s) => s.tradeCount >= 3) // Minimum sample size
      .sort((a, b) => b.avgPnlWhenUsed - a.avgPnlWhenUsed)
      .slice(0, 5);

    return {
      totalTrades: allTrades.length,
      closedTrades: closedTrades.length,
      winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0,
      totalPnl,
      avgPnl: closedTrades.length > 0 ? totalPnl / closedTrades.length : 0,
      profitFactor: totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0,
      bestDataSources,
    };
  }

  /**
   * Get strategy recommendations based on historical performance
   */
  getStrategyRecommendations(): string[] {
    const stats = this.getOverallStats();
    const recommendations: string[] = [];

    if (stats.closedTrades < 10) {
      recommendations.push('Need more trades to generate meaningful recommendations. Current sample size: ' + stats.closedTrades);
      return recommendations;
    }

    // Win rate recommendations
    if (stats.winRate > 60) {
      recommendations.push('High win rate suggests good entry timing. Consider increasing position sizes slightly.');
    } else if (stats.winRate < 45) {
      recommendations.push('Low win rate indicates need for stricter entry criteria. Wait for higher confidence signals.');
    }

    // Profit factor recommendations
    if (stats.profitFactor > 2) {
      recommendations.push('Excellent profit factor. Strategy is working well - maintain current approach.');
    } else if (stats.profitFactor < 1) {
      recommendations.push('Negative profit factor. Need to cut losses faster or improve signal quality.');
    }

    // Data source recommendations
    if (stats.bestDataSources.length > 0) {
      const best = stats.bestDataSources[0];
      recommendations.push(`${best.source} (${best.type}) signals have ${best.winRate.toFixed(0)}% accuracy. Prioritize these signals.`);
    }

    return recommendations;
  }

  // ============= Utility Functions =============

  private getDateStr(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Monday start
    return new Date(d.setDate(diff));
  }

  private trimOldTrades(): void {
    if (this.trades.size > this.MAX_TRADES) {
      const sorted = Array.from(this.trades.entries()).sort(
        ([, a], [, b]) => a.entryTime.getTime() - b.entryTime.getTime()
      );
      const toRemove = sorted.slice(0, this.trades.size - this.MAX_TRADES);
      for (const [id] of toRemove) {
        this.trades.delete(id);
      }
    }
  }

  // ============= Persistence =============

  private async loadPersistedData(): Promise<void> {
    if (!this.runtime) return;

    try {
      const tradesData = await this.runtime.getCache<string>('strategy-learning:trades');
      if (tradesData) {
        const parsed = JSON.parse(tradesData);
        for (const trade of parsed) {
          trade.entryTime = new Date(trade.entryTime);
          if (trade.exitTime) trade.exitTime = new Date(trade.exitTime);
          for (const signal of trade.dataSignals) {
            signal.timestamp = new Date(signal.timestamp);
          }
          this.trades.set(trade.id, trade);
        }
        logger.info({ count: this.trades.size }, '[StrategyLearning] Loaded persisted trades');
      }

      const perfData = await this.runtime.getCache<string>('strategy-learning:performance');
      if (perfData) {
        const parsed = JSON.parse(perfData);
        for (const [key, value] of Object.entries(parsed)) {
          (value as DataSourcePerformance).lastUpdated = new Date((value as DataSourcePerformance).lastUpdated);
          this.dataSourcePerformance.set(key, value as DataSourcePerformance);
        }
      }
    } catch (error) {
      logger.warn({ error }, '[StrategyLearning] Failed to load persisted data');
    }
  }

  private async persistData(): Promise<void> {
    if (!this.runtime) return;

    try {
      const tradesData = JSON.stringify(Array.from(this.trades.values()));
      await this.runtime.setCache('strategy-learning:trades', tradesData);

      const perfData = JSON.stringify(Object.fromEntries(this.dataSourcePerformance));
      await this.runtime.setCache('strategy-learning:performance', perfData);

      logger.info('[StrategyLearning] Data persisted successfully');
    } catch (error) {
      logger.warn({ error }, '[StrategyLearning] Failed to persist data');
    }
  }

  // ============= Public Getters =============

  getAllTrades(): TradeRecord[] {
    return Array.from(this.trades.values());
  }

  getOpenTrades(): TradeRecord[] {
    return Array.from(this.trades.values()).filter((t) => !t.resolved);
  }

  getClosedTrades(): TradeRecord[] {
    return Array.from(this.trades.values()).filter((t) => t.resolved);
  }

  getTradeById(id: string): TradeRecord | undefined {
    return this.trades.get(id);
  }

  getDataSourcePerformance(): DataSourcePerformance[] {
    return Array.from(this.dataSourcePerformance.values());
  }
}
