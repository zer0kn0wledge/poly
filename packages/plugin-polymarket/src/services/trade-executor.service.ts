/**
 * Trade Executor Service
 *
 * Executes trades on Polymarket based on edge calculator recommendations.
 * Handles order placement, position management, and trade logging.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { PolymarketService } from './polymarket';
import { EdgeCalculatorService, type TradingOpportunity } from './edge-calculator.service';
import type { CryptoPriceMarket } from './crypto-market-discovery.service';
import type { OrderSide } from '../types';

// ============= Types =============

export interface TradeResult {
  success: boolean;
  orderId?: string;
  market: CryptoPriceMarket;
  side: 'YES' | 'NO';
  size: number;
  price: number;
  filledSize?: number;
  error?: string;
  timestamp: Date;
}

export interface TradeDecision {
  opportunity: TradingOpportunity;
  approved: boolean;
  reason: string;
  adjustedSize?: number;
}

export interface ExecutorConfig {
  autoTradeEnabled: boolean;
  minConfidence: number;       // Minimum confidence to auto-trade (default: 70)
  minRating: 'STRONG_BUY' | 'BUY';  // Minimum rating (default: BUY)
  maxConcurrentTrades: number; // Max simultaneous trades (default: 3)
  cooldownMinutes: number;     // Minutes between trades on same market (default: 60)
  dryRun: boolean;             // If true, don't place real orders
}

const DEFAULT_CONFIG: ExecutorConfig = {
  autoTradeEnabled: false,
  minConfidence: 70,
  minRating: 'BUY',
  maxConcurrentTrades: 3,
  cooldownMinutes: 60,
  dryRun: true,
};

// ============= Service =============

export class TradeExecutorService extends Service {
  static readonly serviceType = 'trade-executor';
  readonly capabilityDescription = 'Executes crypto price prediction trades on Polymarket';

  private runtime: IAgentRuntime | null = null;
  private polymarketService: PolymarketService | null = null;
  private edgeCalculator: EdgeCalculatorService | null = null;
  private config: ExecutorConfig = DEFAULT_CONFIG;

  // Trade tracking
  private recentTrades: TradeResult[] = [];
  private marketCooldowns: Map<string, Date> = new Map();
  private activeTradeCount: number = 0;

  static async start(runtime: IAgentRuntime): Promise<TradeExecutorService> {
    const service = new TradeExecutorService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info('[TradeExecutor] Initializing trade executor service');

    // Load config from environment
    this.config = {
      ...DEFAULT_CONFIG,
      autoTradeEnabled: process.env.POLYMARKET_AUTO_TRADE === 'true',
      minConfidence: parseInt(process.env.POLYMARKET_MIN_CONFIDENCE || '70'),
      dryRun: process.env.POLYMARKET_DRY_RUN !== 'false',
    };

    // Link services after initialization
    setTimeout(() => this.linkServices(), 6000);

    logger.info({ config: this.config }, '[TradeExecutor] Service initialized');
  }

  private linkServices(): void {
    if (!this.runtime) return;

    this.polymarketService = this.runtime.getService<PolymarketService>('polymarket');
    this.edgeCalculator = this.runtime.getService<EdgeCalculatorService>('edge-calculator');

    logger.info({
      hasPolymarket: !!this.polymarketService,
      hasEdgeCalculator: !!this.edgeCalculator,
    }, '[TradeExecutor] Services linked');
  }

  async stop(): Promise<void> {
    logger.info('[TradeExecutor] Service stopped');
  }

  // ============= Trade Execution =============

  /**
   * Execute a trade based on an opportunity
   */
  async executeTrade(opportunity: TradingOpportunity): Promise<TradeResult> {
    const market = opportunity.market;

    // Ensure services
    if (!this.polymarketService) {
      this.linkServices();
      if (!this.polymarketService) {
        return this.createFailedResult(market, opportunity.side, 'Polymarket service not available');
      }
    }

    // Check cooldown
    const cooldownEnd = this.marketCooldowns.get(market.id);
    if (cooldownEnd && new Date() < cooldownEnd) {
      return this.createFailedResult(market, opportunity.side, 'Market on cooldown');
    }

    // Check concurrent trade limit
    if (this.activeTradeCount >= this.config.maxConcurrentTrades) {
      return this.createFailedResult(market, opportunity.side, 'Max concurrent trades reached');
    }

    // Determine token ID and price
    const tokenId = opportunity.side === 'YES' ? market.yesTokenId : market.noTokenId;
    const price = opportunity.side === 'YES' ? market.yesPrice : market.noPrice;

    if (!tokenId) {
      return this.createFailedResult(market, opportunity.side, 'No token ID for this side');
    }

    // Calculate actual size
    const size = Math.max(1, Math.floor(opportunity.recommendedSize));

    logger.info({
      market: market.question.slice(0, 50),
      side: opportunity.side,
      size,
      price,
      edge: opportunity.edgePercent.toFixed(1),
      confidence: opportunity.confidence.toFixed(0),
      dryRun: this.config.dryRun,
    }, '[TradeExecutor] Executing trade');

    // Dry run mode
    if (this.config.dryRun) {
      const result: TradeResult = {
        success: true,
        orderId: `DRY_RUN_${Date.now()}`,
        market,
        side: opportunity.side,
        size,
        price,
        filledSize: size,
        timestamp: new Date(),
      };

      this.recordTrade(result);
      this.setMarketCooldown(market.id);

      logger.info({
        orderId: result.orderId,
        side: opportunity.side,
        size,
      }, '[TradeExecutor] DRY RUN trade recorded');

      return result;
    }

    // Real trade
    try {
      this.activeTradeCount++;

      const orderResult = await this.polymarketService.placeOrder({
        tokenId,
        side: 'BUY' as OrderSide,  // Always buying the side we want
        price,
        size,
        type: 'GTC',  // Good-til-cancelled
      });

      const result: TradeResult = {
        success: true,
        orderId: orderResult.orderId,
        market,
        side: opportunity.side,
        size,
        price,
        filledSize: orderResult.filledSize,
        timestamp: new Date(),
      };

      this.recordTrade(result);
      this.setMarketCooldown(market.id);

      logger.info({
        orderId: orderResult.orderId,
        status: orderResult.status,
        filledSize: orderResult.filledSize,
      }, '[TradeExecutor] Trade executed successfully');

      return result;

    } catch (error: any) {
      const result = this.createFailedResult(
        market,
        opportunity.side,
        error?.message || String(error)
      );
      this.recordTrade(result);
      return result;

    } finally {
      this.activeTradeCount = Math.max(0, this.activeTradeCount - 1);
    }
  }

  /**
   * Evaluate and potentially execute trades for top opportunities
   */
  async evaluateAndExecute(): Promise<TradeResult[]> {
    if (!this.config.autoTradeEnabled) {
      logger.debug('[TradeExecutor] Auto-trade disabled');
      return [];
    }

    // Ensure edge calculator
    if (!this.edgeCalculator) {
      this.linkServices();
      if (!this.edgeCalculator) {
        logger.warn('[TradeExecutor] Edge calculator not available');
        return [];
      }
    }

    try {
      // Get opportunities
      const opportunities = await this.edgeCalculator.findOpportunities();

      // Filter by our criteria
      const tradeable = opportunities.filter(opp =>
        this.shouldTrade(opp)
      );

      logger.info({
        total: opportunities.length,
        tradeable: tradeable.length,
      }, '[TradeExecutor] Evaluating opportunities');

      // Execute trades
      const results: TradeResult[] = [];
      for (const opp of tradeable.slice(0, this.config.maxConcurrentTrades)) {
        const result = await this.executeTrade(opp);
        results.push(result);

        // Small delay between trades
        await new Promise(r => setTimeout(r, 1000));
      }

      return results;

    } catch (error) {
      logger.error({ error: String(error) }, '[TradeExecutor] Error in evaluateAndExecute');
      return [];
    }
  }

  /**
   * Determine if we should trade an opportunity
   */
  private shouldTrade(opportunity: TradingOpportunity): boolean {
    // Check rating
    if (this.config.minRating === 'STRONG_BUY' && opportunity.rating !== 'STRONG_BUY') {
      return false;
    }
    if (this.config.minRating === 'BUY' &&
        opportunity.rating !== 'STRONG_BUY' &&
        opportunity.rating !== 'BUY') {
      return false;
    }

    // Check confidence
    if (opportunity.confidence < this.config.minConfidence) {
      return false;
    }

    // Check cooldown
    const cooldownEnd = this.marketCooldowns.get(opportunity.market.id);
    if (cooldownEnd && new Date() < cooldownEnd) {
      return false;
    }

    // Check minimum size
    if (opportunity.recommendedSize < 1) {
      return false;
    }

    return true;
  }

  // ============= Trade Decision =============

  /**
   * Make a trade decision with detailed reasoning
   */
  makeDecision(opportunity: TradingOpportunity): TradeDecision {
    const reasons: string[] = [];
    let approved = true;

    // Check rating
    if (opportunity.rating === 'AVOID') {
      approved = false;
      reasons.push('Rating is AVOID');
    } else if (opportunity.rating === 'HOLD') {
      approved = false;
      reasons.push('Rating is HOLD - not compelling enough');
    }

    // Check confidence
    if (opportunity.confidence < this.config.minConfidence) {
      approved = false;
      reasons.push(`Confidence ${opportunity.confidence.toFixed(0)}% below minimum ${this.config.minConfidence}%`);
    }

    // Check edge
    if (Math.abs(opportunity.edge) < 0.05) {
      approved = false;
      reasons.push(`Edge ${(opportunity.edge * 100).toFixed(1)}% too small`);
    }

    // Check liquidity
    if (opportunity.market.liquidity < 5000) {
      reasons.push('Low liquidity warning');
    }

    // Check time to expiry
    if (opportunity.market.daysToExpiry < 3) {
      reasons.push('Short time to expiry - increased risk');
    }

    // Check risk factors
    if (opportunity.riskFactors.length > 2) {
      reasons.push(`Multiple risk factors: ${opportunity.riskFactors.length}`);
    }

    // Determine adjusted size based on risks
    let adjustedSize = opportunity.recommendedSize;
    if (opportunity.riskFactors.length > 0) {
      adjustedSize *= Math.max(0.5, 1 - (opportunity.riskFactors.length * 0.15));
    }

    return {
      opportunity,
      approved,
      reason: reasons.length > 0 ? reasons.join('; ') : 'All criteria met',
      adjustedSize: Math.floor(adjustedSize),
    };
  }

  // ============= Helpers =============

  private createFailedResult(
    market: CryptoPriceMarket,
    side: 'YES' | 'NO',
    error: string
  ): TradeResult {
    return {
      success: false,
      market,
      side,
      size: 0,
      price: 0,
      error,
      timestamp: new Date(),
    };
  }

  private recordTrade(result: TradeResult): void {
    this.recentTrades.unshift(result);
    // Keep last 100 trades
    if (this.recentTrades.length > 100) {
      this.recentTrades = this.recentTrades.slice(0, 100);
    }
  }

  private setMarketCooldown(marketId: string): void {
    const cooldownEnd = new Date();
    cooldownEnd.setMinutes(cooldownEnd.getMinutes() + this.config.cooldownMinutes);
    this.marketCooldowns.set(marketId, cooldownEnd);
  }

  // ============= Public API =============

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 10): TradeResult[] {
    return this.recentTrades.slice(0, limit);
  }

  /**
   * Get trade statistics
   */
  getTradeStats(): {
    totalTrades: number;
    successfulTrades: number;
    failedTrades: number;
    totalVolume: number;
    avgSize: number;
  } {
    const successful = this.recentTrades.filter(t => t.success);
    const totalVolume = successful.reduce((sum, t) => sum + (t.filledSize || t.size) * t.price, 0);

    return {
      totalTrades: this.recentTrades.length,
      successfulTrades: successful.length,
      failedTrades: this.recentTrades.length - successful.length,
      totalVolume,
      avgSize: successful.length > 0 ? totalVolume / successful.length : 0,
    };
  }

  /**
   * Format recent trades for display
   */
  formatRecentTrades(): string {
    const trades = this.getRecentTrades(5);

    if (trades.length === 0) {
      return 'No recent trades.';
    }

    let output = 'RECENT TRADES\n\n';

    for (const trade of trades) {
      const status = trade.success ? 'SUCCESS' : 'FAILED';
      const time = trade.timestamp.toLocaleTimeString();
      output += `[${status}] ${time} - ${trade.market.coinSymbol}\n`;
      output += `  ${trade.market.question.slice(0, 50)}...\n`;
      output += `  Side: ${trade.side} | Size: $${trade.size} | Price: ${(trade.price * 100).toFixed(0)}%\n`;
      if (trade.error) {
        output += `  Error: ${trade.error}\n`;
      }
      output += '\n';
    }

    return output;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ExecutorConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info({ config: this.config }, '[TradeExecutor] Config updated');
  }

  /**
   * Clear cooldowns (for testing)
   */
  clearCooldowns(): void {
    this.marketCooldowns.clear();
    logger.info('[TradeExecutor] Cooldowns cleared');
  }

  /**
   * Check if service is ready to trade
   */
  isReady(): boolean {
    return !!this.polymarketService && !!this.edgeCalculator;
  }

  /**
   * Get current config
   */
  getConfig(): ExecutorConfig {
    return { ...this.config };
  }
}
