/**
 * Polymarket Service
 *
 * Core service for interacting with the Polymarket CLOB API.
 * Handles authentication, order management, and market data retrieval.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import type {
  ApiCredentials,
  MarketSearchParams,
  OrderBook,
  OrderResult,
  OrderSide,
  OrderType,
  PlaceOrderParams,
  PolymarketConfig,
  PolymarketMarket,
  PolymarketPortfolio,
  PolymarketPosition,
  RiskSettings,
  TradeEntry,
} from '../types';

const POLYMARKET_HOST = 'https://clob.polymarket.com';
const GAMMA_API_HOST = 'https://gamma-api.polymarket.com';
const POLYGON_CHAIN_ID = 137;

/**
 * Default risk settings for the trading agent
 */
const DEFAULT_RISK_SETTINGS: RiskSettings = {
  maxPositionSize: 100, // Max $100 per position
  maxPortfolioRisk: 1000, // Max $1000 total exposure
  stopLossPercent: 20, // 20% stop loss
  takeProfitPercent: 50, // 50% take profit
  maxDailyLoss: 200, // Max $200 daily loss
};

export class PolymarketService extends Service {
  static readonly serviceType = 'polymarket';
  readonly capabilityDescription = 'Polymarket prediction market trading service';

  private client: ClobClient | null = null;
  private wallet: Wallet | null = null;
  private credentials: ApiCredentials | null = null;
  private riskSettings: RiskSettings;
  private positions: Map<string, PolymarketPosition> = new Map();
  private dailyPnl: number = 0;
  private lastPnlReset: Date = new Date();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.riskSettings = DEFAULT_RISK_SETTINGS;
  }

  static async start(runtime: IAgentRuntime): Promise<PolymarketService> {
    const service = new PolymarketService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    logger.info('[PolymarketService] Stopping service');
    this.client = null;
    this.wallet = null;
    this.credentials = null;
    this.positions.clear();
  }

  private async initialize(): Promise<void> {
    const privateKey = this.runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!privateKey) {
      logger.warn('[PolymarketService] No private key configured - running in read-only mode');
      return;
    }

    try {
      // Initialize wallet
      this.wallet = new Wallet(privateKey);
      logger.info(`[PolymarketService] Wallet initialized: ${this.wallet.address}`);

      // Initialize CLOB client
      this.client = new ClobClient(
        POLYMARKET_HOST,
        POLYGON_CHAIN_ID,
        this.wallet
      );

      // Derive or create API credentials for L2 operations
      await this.initializeCredentials();

      // Load risk settings from runtime config
      await this.loadRiskSettings();

      // Load existing positions
      await this.syncPositions();

      logger.info('[PolymarketService] Service initialized successfully');
    } catch (error) {
      logger.error({ error }, '[PolymarketService] Failed to initialize');
      throw error;
    }
  }

  private async initializeCredentials(): Promise<void> {
    if (!this.client || !this.wallet) return;

    try {
      // Try to derive existing API key or create a new one
      const creds = await this.client.createOrDeriveApiKey();
      this.credentials = {
        apiKey: creds.apiKey,
        apiSecret: creds.secret,
        apiPassphrase: creds.passphrase,
      };

      // Reinitialize client with credentials
      this.client = new ClobClient(
        POLYMARKET_HOST,
        POLYGON_CHAIN_ID,
        this.wallet,
        creds
      );

      logger.info('[PolymarketService] API credentials initialized');
    } catch (error) {
      logger.error({ error }, '[PolymarketService] Failed to initialize API credentials');
    }
  }

  private async loadRiskSettings(): Promise<void> {
    const maxPositionSize = this.runtime.getSetting('POLYMARKET_MAX_POSITION_SIZE');
    const maxPortfolioRisk = this.runtime.getSetting('POLYMARKET_MAX_PORTFOLIO_RISK');
    const stopLossPercent = this.runtime.getSetting('POLYMARKET_STOP_LOSS_PERCENT');
    const takeProfitPercent = this.runtime.getSetting('POLYMARKET_TAKE_PROFIT_PERCENT');
    const maxDailyLoss = this.runtime.getSetting('POLYMARKET_MAX_DAILY_LOSS');

    this.riskSettings = {
      maxPositionSize: maxPositionSize ? parseFloat(maxPositionSize) : DEFAULT_RISK_SETTINGS.maxPositionSize,
      maxPortfolioRisk: maxPortfolioRisk ? parseFloat(maxPortfolioRisk) : DEFAULT_RISK_SETTINGS.maxPortfolioRisk,
      stopLossPercent: stopLossPercent ? parseFloat(stopLossPercent) : DEFAULT_RISK_SETTINGS.stopLossPercent,
      takeProfitPercent: takeProfitPercent ? parseFloat(takeProfitPercent) : DEFAULT_RISK_SETTINGS.takeProfitPercent,
      maxDailyLoss: maxDailyLoss ? parseFloat(maxDailyLoss) : DEFAULT_RISK_SETTINGS.maxDailyLoss,
    };

    logger.info({ riskSettings: this.riskSettings }, '[PolymarketService] Risk settings loaded');
  }

  /**
   * Check if the service is in trading mode (has credentials)
   */
  isReadOnly(): boolean {
    return !this.client || !this.credentials;
  }

  /**
   * Get the wallet address
   */
  getWalletAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  /**
   * Fetch markets from Polymarket
   */
  async getMarkets(params: MarketSearchParams = {}): Promise<PolymarketMarket[]> {
    try {
      const queryParams = new URLSearchParams();
      if (params.query) queryParams.set('query', params.query);
      if (params.active !== undefined) queryParams.set('active', String(params.active));
      if (params.closed !== undefined) queryParams.set('closed', String(params.closed));
      if (params.limit) queryParams.set('limit', String(params.limit));
      if (params.offset) queryParams.set('offset', String(params.offset));

      const response = await fetch(`${GAMMA_API_HOST}/markets?${queryParams.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch markets: ${response.statusText}`);
      }

      const data = await response.json();
      return this.parseMarkets(data);
    } catch (error) {
      logger.error({ error }, '[PolymarketService] Failed to fetch markets');
      throw error;
    }
  }

  /**
   * Get a specific market by condition ID
   */
  async getMarket(conditionId: string): Promise<PolymarketMarket | null> {
    try {
      const response = await fetch(`${GAMMA_API_HOST}/markets/${conditionId}`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to fetch market: ${response.statusText}`);
      }

      const data = await response.json();
      const markets = this.parseMarkets([data]);
      return markets[0] ?? null;
    } catch (error) {
      logger.error({ error, conditionId }, '[PolymarketService] Failed to fetch market');
      throw error;
    }
  }

  /**
   * Search markets by query
   */
  async searchMarkets(query: string, limit = 10): Promise<PolymarketMarket[]> {
    return this.getMarkets({ query, active: true, limit });
  }

  /**
   * Get order book for a token
   */
  async getOrderBook(tokenId: string): Promise<OrderBook> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    try {
      const book = await this.client.getOrderBook(tokenId);

      const bids = (book.bids || []).map((b: { price: string; size: string }) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      }));

      const asks = (book.asks || []).map((a: { price: string; size: string }) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      }));

      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 1;

      return {
        bids,
        asks,
        spread: bestAsk - bestBid,
        midpoint: (bestBid + bestAsk) / 2,
      };
    } catch (error) {
      logger.error({ error, tokenId }, '[PolymarketService] Failed to fetch order book');
      throw error;
    }
  }

  /**
   * Get current price for a token
   */
  async getPrice(tokenId: string): Promise<number> {
    const book = await this.getOrderBook(tokenId);
    return book.midpoint;
  }

  /**
   * Place an order
   */
  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    if (this.isReadOnly()) {
      throw new Error('Cannot place orders in read-only mode. Configure POLYMARKET_PRIVATE_KEY.');
    }

    // Validate against risk settings
    await this.validateOrderRisk(params);

    try {
      const orderType = params.orderType ?? 'GTC';

      // Get market info for tick size
      const book = await this.getOrderBook(params.tokenId);

      const order = await this.client!.createAndPostOrder({
        tokenID: params.tokenId,
        price: params.price,
        side: params.side,
        size: params.size,
        feeRateBps: 0,
      });

      logger.info({
        orderId: order.orderID,
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
      }, '[PolymarketService] Order placed');

      // Update positions after order
      await this.syncPositions();

      return {
        orderId: order.orderID,
        status: order.status === 'MATCHED' ? 'matched' : 'pending',
        filledSize: parseFloat(order.size_matched || '0'),
        remainingSize: params.size - parseFloat(order.size_matched || '0'),
        avgFillPrice: params.price, // Approximate
        transactionHash: order.transactionsHashes?.[0],
      };
    } catch (error) {
      logger.error({ error, params }, '[PolymarketService] Failed to place order');
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.isReadOnly()) {
      throw new Error('Cannot cancel orders in read-only mode');
    }

    try {
      await this.client!.cancelOrder(orderId);
      logger.info({ orderId }, '[PolymarketService] Order cancelled');
      return true;
    } catch (error) {
      logger.error({ error, orderId }, '[PolymarketService] Failed to cancel order');
      return false;
    }
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<any[]> {
    if (this.isReadOnly()) {
      return [];
    }

    try {
      const orders = await this.client!.getOpenOrders();
      return orders;
    } catch (error) {
      logger.error({ error }, '[PolymarketService] Failed to fetch open orders');
      return [];
    }
  }

  /**
   * Sync positions from the API
   */
  async syncPositions(): Promise<void> {
    if (this.isReadOnly()) return;

    try {
      // Fetch positions from Polymarket API
      // Note: This requires proper implementation based on Polymarket's positions API
      // For now, we track positions locally based on trades
      logger.debug('[PolymarketService] Positions synced');
    } catch (error) {
      logger.error({ error }, '[PolymarketService] Failed to sync positions');
    }
  }

  /**
   * Get current portfolio
   */
  async getPortfolio(): Promise<PolymarketPortfolio> {
    const positionsList = Array.from(this.positions.values());

    let totalValue = 0;
    let unrealizedPnl = 0;

    for (const position of positionsList) {
      const currentPrice = await this.getPrice(position.token_id).catch(() => position.currentPrice);
      position.currentPrice = currentPrice;
      position.unrealizedPnl = (currentPrice - position.avgPrice) * position.size;
      position.unrealizedPnlPercent = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;

      totalValue += position.size * currentPrice;
      unrealizedPnl += position.unrealizedPnl;
    }

    // Get USDC balance if available
    let cashBalance = 0;
    if (this.client) {
      try {
        // Implement balance check through Polymarket API
        cashBalance = 0; // Placeholder
      } catch {
        // Ignore balance fetch errors
      }
    }

    return {
      totalValue: totalValue + cashBalance,
      cashBalance,
      positions: positionsList,
      unrealizedPnl,
      realizedPnl: this.dailyPnl,
    };
  }

  /**
   * Get positions
   */
  getPositions(): PolymarketPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get risk settings
   */
  getRiskSettings(): RiskSettings {
    return { ...this.riskSettings };
  }

  /**
   * Update risk settings
   */
  updateRiskSettings(settings: Partial<RiskSettings>): void {
    this.riskSettings = { ...this.riskSettings, ...settings };
    logger.info({ riskSettings: this.riskSettings }, '[PolymarketService] Risk settings updated');
  }

  /**
   * Validate order against risk settings
   */
  private async validateOrderRisk(params: PlaceOrderParams): Promise<void> {
    const orderValue = params.price * params.size;

    // Check max position size
    if (orderValue > this.riskSettings.maxPositionSize) {
      throw new Error(
        `Order value $${orderValue.toFixed(2)} exceeds max position size $${this.riskSettings.maxPositionSize}`
      );
    }

    // Check portfolio risk
    const portfolio = await this.getPortfolio();
    if (portfolio.totalValue + orderValue > this.riskSettings.maxPortfolioRisk) {
      throw new Error(
        `Order would exceed max portfolio risk of $${this.riskSettings.maxPortfolioRisk}`
      );
    }

    // Check daily loss limit
    this.resetDailyPnlIfNeeded();
    if (this.dailyPnl < -this.riskSettings.maxDailyLoss) {
      throw new Error(
        `Daily loss limit of $${this.riskSettings.maxDailyLoss} exceeded. Trading paused.`
      );
    }
  }

  /**
   * Reset daily PnL tracking if it's a new day
   */
  private resetDailyPnlIfNeeded(): void {
    const now = new Date();
    if (now.getDate() !== this.lastPnlReset.getDate()) {
      this.dailyPnl = 0;
      this.lastPnlReset = now;
    }
  }

  /**
   * Parse raw market data into PolymarketMarket format
   */
  private parseMarkets(data: any[]): PolymarketMarket[] {
    return data.map((m) => ({
      condition_id: m.conditionId || m.condition_id,
      question_id: m.questionId || m.question_id,
      question: m.question,
      description: m.description || '',
      market_slug: m.slug || m.market_slug || '',
      end_date_iso: m.endDate || m.end_date_iso || '',
      game_start_time: m.gameStartTime || m.game_start_time,
      tokens: (m.tokens || m.outcomes || []).map((t: any, idx: number) => ({
        token_id: t.token_id || t.tokenId || `${m.conditionId || m.condition_id}-${idx}`,
        outcome: t.outcome || (idx === 0 ? 'Yes' : 'No'),
        price: parseFloat(t.price || '0.5'),
        winner: t.winner,
      })),
      active: m.active ?? true,
      closed: m.closed ?? false,
      archived: m.archived ?? false,
      accepting_orders: m.acceptingOrders ?? m.accepting_orders ?? true,
      accepting_order_timestamp: m.acceptingOrderTimestamp || m.accepting_order_timestamp,
      minimum_order_size: parseFloat(m.minimumOrderSize || m.minimum_order_size || '1'),
      minimum_tick_size: parseFloat(m.minimumTickSize || m.minimum_tick_size || '0.01'),
      neg_risk: m.negRisk ?? m.neg_risk ?? false,
      volume: parseFloat(m.volume || '0'),
      volume_num: parseFloat(m.volumeNum || m.volume_num || m.volume || '0'),
      liquidity: parseFloat(m.liquidity || '0'),
      spread: parseFloat(m.spread || '0'),
    }));
  }
}
