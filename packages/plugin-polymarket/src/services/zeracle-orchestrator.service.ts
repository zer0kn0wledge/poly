/**
 * Zeracle Crypto Agent Orchestrator
 *
 * The main coordination service for Zeracle - a crypto-only price prediction trading agent.
 * Orchestrates market discovery, technical analysis, edge calculation, and trade execution.
 *
 * FOCUS: Exclusively crypto price betting using CoinGecko technical analysis.
 * NO politics, NO sports, NO general events - ONLY crypto price predictions.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { CoinGeckoDataService, type PriceData } from './coingecko-data.service';
import { TechnicalAnalysisService, type TechnicalIndicators } from './technical-analysis.service';
import { CryptoMarketDiscoveryService, type CryptoPriceMarket } from './crypto-market-discovery.service';
import { EdgeCalculatorService, type TradingOpportunity } from './edge-calculator.service';
import { TradeExecutorService, type TradeResult } from './trade-executor.service';
import { TwitterService } from './twitter';

// ============= Types =============

export interface OrchestratorStatus {
  isRunning: boolean;
  lastAnalysisTime: Date | null;
  lastTradeTime: Date | null;
  marketsDiscovered: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  servicesReady: {
    coinGecko: boolean;
    technicalAnalysis: boolean;
    marketDiscovery: boolean;
    edgeCalculator: boolean;
    tradeExecutor: boolean;
    twitter: boolean;
  };
}

export interface AnalysisCycle {
  timestamp: Date;
  marketsScanned: number;
  cryptoMarketsFound: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  topOpportunities: TradingOpportunity[];
  errors: string[];
}

export interface OrchestratorConfig {
  analysisIntervalMs: number;    // How often to run analysis (default: 5 min)
  autoTradeEnabled: boolean;     // Auto-execute trades
  postAnalysisToTwitter: boolean;  // Post insights to Twitter
  minOpportunitiesForPost: number;  // Min opportunities to trigger post
  maxTradesPerCycle: number;     // Max trades per analysis cycle
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  analysisIntervalMs: 5 * 60 * 1000,  // 5 minutes
  autoTradeEnabled: false,
  postAnalysisToTwitter: true,
  minOpportunitiesForPost: 1,
  maxTradesPerCycle: 2,
};

// ============= Service =============

export class ZeracleOrchestratorService extends Service {
  static readonly serviceType = 'zeracle-orchestrator';
  readonly capabilityDescription = 'Crypto price prediction trading agent - analyzes markets and executes trades';

  private runtime: IAgentRuntime | null = null;
  private config: OrchestratorConfig = DEFAULT_CONFIG;

  // Dependent services
  private coinGeckoService: CoinGeckoDataService | null = null;
  private taService: TechnicalAnalysisService | null = null;
  private discoveryService: CryptoMarketDiscoveryService | null = null;
  private edgeCalculator: EdgeCalculatorService | null = null;
  private tradeExecutor: TradeExecutorService | null = null;
  private twitterService: TwitterService | null = null;

  // State
  private isRunning: boolean = false;
  private analysisTimer: NodeJS.Timeout | null = null;
  private lastAnalysisTime: Date | null = null;
  private lastTradeTime: Date | null = null;
  private cycleHistory: AnalysisCycle[] = [];
  private totalTradesExecuted: number = 0;

  static async start(runtime: IAgentRuntime): Promise<ZeracleOrchestratorService> {
    const service = new ZeracleOrchestratorService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info('[Zeracle] Initializing Zeracle Crypto Agent Orchestrator');

    // Load config
    this.config = {
      ...DEFAULT_CONFIG,
      analysisIntervalMs: parseInt(process.env.POLYMARKET_ANALYSIS_INTERVAL || '300000'),
      autoTradeEnabled: process.env.POLYMARKET_AUTO_TRADE === 'true',
      postAnalysisToTwitter: process.env.POLYMARKET_POST_ANALYSIS !== 'false',
    };

    // Link services after all are initialized
    setTimeout(() => {
      this.linkServices();
      this.startAnalysisLoop();
    }, 8000);

    logger.info({ config: this.config }, '[Zeracle] Orchestrator initialized');
  }

  private linkServices(): void {
    if (!this.runtime) return;

    this.coinGeckoService = this.runtime.getService<CoinGeckoDataService>('coingecko-data');
    this.taService = this.runtime.getService<TechnicalAnalysisService>('technical-analysis');
    this.discoveryService = this.runtime.getService<CryptoMarketDiscoveryService>('crypto-market-discovery');
    this.edgeCalculator = this.runtime.getService<EdgeCalculatorService>('edge-calculator');
    this.tradeExecutor = this.runtime.getService<TradeExecutorService>('trade-executor');
    this.twitterService = this.runtime.getService<TwitterService>('twitter');

    const status = this.getServicesStatus();
    logger.info({ services: status }, '[Zeracle] Services linked');

    // Log warning if any core services are missing
    if (!status.coinGecko || !status.marketDiscovery || !status.edgeCalculator) {
      logger.warn('[Zeracle] Some core services not available - functionality will be limited');
    }
  }

  private getServicesStatus() {
    return {
      coinGecko: !!this.coinGeckoService,
      technicalAnalysis: !!this.taService,
      marketDiscovery: !!this.discoveryService,
      edgeCalculator: !!this.edgeCalculator,
      tradeExecutor: !!this.tradeExecutor,
      twitter: !!this.twitterService,
    };
  }

  async stop(): Promise<void> {
    this.stopAnalysisLoop();
    logger.info('[Zeracle] Orchestrator stopped');
  }

  // ============= Analysis Loop =============

  private startAnalysisLoop(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    logger.info({
      intervalMs: this.config.analysisIntervalMs,
      autoTrade: this.config.autoTradeEnabled,
    }, '[Zeracle] Starting analysis loop');

    // Run immediately, then on interval
    this.runAnalysisCycle().catch(err =>
      logger.error({ error: String(err) }, '[Zeracle] Initial analysis failed')
    );

    this.analysisTimer = setInterval(() => {
      this.runAnalysisCycle().catch(err =>
        logger.error({ error: String(err) }, '[Zeracle] Analysis cycle failed')
      );
    }, this.config.analysisIntervalMs);
  }

  private stopAnalysisLoop(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    this.isRunning = false;
    logger.info('[Zeracle] Analysis loop stopped');
  }

  /**
   * Run a complete analysis cycle
   */
  async runAnalysisCycle(): Promise<AnalysisCycle> {
    const cycle: AnalysisCycle = {
      timestamp: new Date(),
      marketsScanned: 0,
      cryptoMarketsFound: 0,
      opportunitiesFound: 0,
      tradesExecuted: 0,
      topOpportunities: [],
      errors: [],
    };

    logger.info('[Zeracle] Starting analysis cycle');

    try {
      // Step 1: Discover crypto markets
      if (this.discoveryService) {
        const markets = await this.discoveryService.getCryptoPriceMarkets(1000, 5000);
        cycle.cryptoMarketsFound = markets.length;
        logger.info({ count: markets.length }, '[Zeracle] Discovered crypto markets');
      } else {
        cycle.errors.push('Market discovery service not available');
      }

      // Step 2: Find trading opportunities
      if (this.edgeCalculator) {
        const opportunities = await this.edgeCalculator.findOpportunities();
        cycle.opportunitiesFound = opportunities.length;
        cycle.topOpportunities = opportunities.slice(0, 5);

        logger.info({
          total: opportunities.length,
          strongBuy: opportunities.filter(o => o.rating === 'STRONG_BUY').length,
          buy: opportunities.filter(o => o.rating === 'BUY').length,
        }, '[Zeracle] Found opportunities');
      } else {
        cycle.errors.push('Edge calculator not available');
      }

      // Step 3: Execute trades if enabled
      if (this.config.autoTradeEnabled && this.tradeExecutor && cycle.topOpportunities.length > 0) {
        const tradeable = cycle.topOpportunities.filter(o =>
          o.rating === 'STRONG_BUY' || o.rating === 'BUY'
        );

        for (const opp of tradeable.slice(0, this.config.maxTradesPerCycle)) {
          const result = await this.tradeExecutor.executeTrade(opp);
          if (result.success) {
            cycle.tradesExecuted++;
            this.totalTradesExecuted++;
            this.lastTradeTime = new Date();
          }
        }

        logger.info({ executed: cycle.tradesExecuted }, '[Zeracle] Trades executed');
      }

      // Step 4: Post analysis to Twitter if configured
      if (this.config.postAnalysisToTwitter &&
          this.twitterService &&
          cycle.opportunitiesFound >= this.config.minOpportunitiesForPost) {
        await this.postAnalysisToTwitter(cycle);
      }

    } catch (error: any) {
      cycle.errors.push(error?.message || String(error));
      logger.error({ error: String(error) }, '[Zeracle] Analysis cycle error');
    }

    // Update state
    this.lastAnalysisTime = cycle.timestamp;
    this.cycleHistory.unshift(cycle);
    if (this.cycleHistory.length > 24) {
      this.cycleHistory = this.cycleHistory.slice(0, 24);
    }

    logger.info({
      marketsFound: cycle.cryptoMarketsFound,
      opportunities: cycle.opportunitiesFound,
      trades: cycle.tradesExecuted,
      errors: cycle.errors.length,
    }, '[Zeracle] Analysis cycle complete');

    return cycle;
  }

  // ============= Twitter Integration =============

  /**
   * Post analysis insights to Twitter
   */
  private async postAnalysisToTwitter(cycle: AnalysisCycle): Promise<void> {
    if (!this.twitterService || cycle.topOpportunities.length === 0) return;

    try {
      const topOpp = cycle.topOpportunities[0];
      const content = this.formatTwitterPost(topOpp, cycle);

      // Use TwitterService to post
      // Note: TwitterService should have proper sanitization to strip any XML tags
      await this.twitterService.postTweet(content);

      logger.info('[Zeracle] Posted analysis to Twitter');
    } catch (error) {
      logger.warn({ error: String(error) }, '[Zeracle] Failed to post to Twitter');
    }
  }

  /**
   * Format opportunity for Twitter post
   */
  private formatTwitterPost(opp: TradingOpportunity, cycle: AnalysisCycle): string {
    const coin = opp.market.coinSymbol;
    const price = opp.currentPrice.toLocaleString();
    const target = opp.targetPrice.toLocaleString();
    const distance = opp.distanceToTarget > 0 ? `+${opp.distanceToTarget.toFixed(1)}` : opp.distanceToTarget.toFixed(1);
    const edge = opp.edge > 0 ? `+${opp.edgePercent.toFixed(1)}` : opp.edgePercent.toFixed(1);
    const ta = opp.technicalAnalysis;

    let post = `${coin} Price Analysis\n\n`;
    post += `Current: $${price}\n`;
    post += `Target: $${target} (${distance}%)\n\n`;
    post += `Technical Signals:\n`;
    post += `Trend: ${ta.trendDirection} (${(ta.trendStrength * 100).toFixed(0)}%)\n`;
    post += `RSI: ${ta.rsi.toFixed(0)} (${ta.rsiSignal})\n`;
    post += `MACD: ${ta.macdSignal}\n\n`;
    post += `Market Edge: ${edge}%\n`;
    post += `Rating: ${opp.rating}\n\n`;
    post += `Scanned ${cycle.cryptoMarketsFound} crypto markets`;

    // Ensure under Twitter limit (280 chars)
    if (post.length > 270) {
      post = `${coin} at $${price}\n`;
      post += `Target: $${target} (${distance}%)\n\n`;
      post += `${ta.trendDirection} trend | RSI ${ta.rsi.toFixed(0)} | MACD ${ta.macdSignal}\n`;
      post += `Edge: ${edge}% | ${opp.rating}`;
    }

    return post;
  }

  // ============= Public API =============

  /**
   * Get orchestrator status
   */
  getStatus(): OrchestratorStatus {
    return {
      isRunning: this.isRunning,
      lastAnalysisTime: this.lastAnalysisTime,
      lastTradeTime: this.lastTradeTime,
      marketsDiscovered: this.cycleHistory[0]?.cryptoMarketsFound || 0,
      opportunitiesFound: this.cycleHistory[0]?.opportunitiesFound || 0,
      tradesExecuted: this.totalTradesExecuted,
      servicesReady: this.getServicesStatus(),
    };
  }

  /**
   * Get cycle history
   */
  getCycleHistory(limit: number = 10): AnalysisCycle[] {
    return this.cycleHistory.slice(0, limit);
  }

  /**
   * Get current opportunities (from last cycle)
   */
  getCurrentOpportunities(): TradingOpportunity[] {
    return this.cycleHistory[0]?.topOpportunities || [];
  }

  /**
   * Force an analysis cycle
   */
  async forceAnalysis(): Promise<AnalysisCycle> {
    return this.runAnalysisCycle();
  }

  /**
   * Get formatted status report
   */
  getStatusReport(): string {
    const status = this.getStatus();
    const lastCycle = this.cycleHistory[0];

    let report = 'ZERACLE CRYPTO AGENT STATUS\n\n';

    report += `Status: ${status.isRunning ? 'RUNNING' : 'STOPPED'}\n`;
    report += `Last Analysis: ${status.lastAnalysisTime?.toLocaleString() || 'Never'}\n`;
    report += `Last Trade: ${status.lastTradeTime?.toLocaleString() || 'Never'}\n\n`;

    report += 'Services:\n';
    const services = status.servicesReady;
    report += `  CoinGecko: ${services.coinGecko ? 'OK' : 'MISSING'}\n`;
    report += `  Technical Analysis: ${services.technicalAnalysis ? 'OK' : 'MISSING'}\n`;
    report += `  Market Discovery: ${services.marketDiscovery ? 'OK' : 'MISSING'}\n`;
    report += `  Edge Calculator: ${services.edgeCalculator ? 'OK' : 'MISSING'}\n`;
    report += `  Trade Executor: ${services.tradeExecutor ? 'OK' : 'MISSING'}\n`;
    report += `  Twitter: ${services.twitter ? 'OK' : 'MISSING'}\n\n`;

    if (lastCycle) {
      report += 'Last Cycle:\n';
      report += `  Markets Scanned: ${lastCycle.cryptoMarketsFound}\n`;
      report += `  Opportunities: ${lastCycle.opportunitiesFound}\n`;
      report += `  Trades: ${lastCycle.tradesExecuted}\n`;

      if (lastCycle.topOpportunities.length > 0) {
        report += '\nTop Opportunities:\n';
        for (const opp of lastCycle.topOpportunities.slice(0, 3)) {
          report += `  [${opp.rating}] ${opp.market.coinSymbol}: Edge ${(opp.edge * 100).toFixed(1)}%\n`;
        }
      }
    }

    report += `\nTotal Trades Executed: ${this.totalTradesExecuted}`;

    return report;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Restart loop if interval changed
    if (newConfig.analysisIntervalMs && this.isRunning) {
      this.stopAnalysisLoop();
      this.startAnalysisLoop();
    }

    logger.info({ config: this.config }, '[Zeracle] Config updated');
  }

  /**
   * Pause the orchestrator
   */
  pause(): void {
    this.stopAnalysisLoop();
    logger.info('[Zeracle] Orchestrator paused');
  }

  /**
   * Resume the orchestrator
   */
  resume(): void {
    this.startAnalysisLoop();
    logger.info('[Zeracle] Orchestrator resumed');
  }
}
