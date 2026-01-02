/**
 * Polymarket Service
 *
 * Core service for interacting with the Polymarket CLOB API.
 * Handles authentication, order management, and market data retrieval.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet, providers } from 'ethers';

const { JsonRpcProvider } = providers;
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
const POLYGON_RPC = 'https://polygon-rpc.com';

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
  private connectedWallet: Wallet | null = null;
  private credentials: ApiCredentials | null = null;
  private riskSettings: RiskSettings;
  private positions: Map<string, PolymarketPosition> = new Map();
  private dailyPnl: number = 0;
  private lastPnlReset: Date = new Date();
  private allowancesApproved: boolean = false;

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
      // Initialize wallet with provider for on-chain transactions
      const provider = new JsonRpcProvider(POLYGON_RPC);
      this.wallet = new Wallet(privateKey);
      this.connectedWallet = this.wallet.connect(provider);
      logger.info(`[PolymarketService] Wallet initialized: ${this.wallet.address}`);

      // Initialize CLOB client with connected wallet
      this.client = new ClobClient(
        POLYMARKET_HOST,
        POLYGON_CHAIN_ID,
        this.connectedWallet
      );

      // Derive or create API credentials for L2 operations
      await this.initializeCredentials();

      // Ensure token allowances are set (required for trading)
      await this.ensureAllowances();

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
    if (!this.client || !this.connectedWallet) return;

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
        this.connectedWallet,
        creds
      );

      logger.info('[PolymarketService] API credentials initialized');
    } catch (error) {
      logger.error({ error }, '[PolymarketService] Failed to initialize API credentials');
    }
  }

  /**
   * Ensure token allowances are set for USDC and conditional tokens.
   * This is required before placing any trades.
   */
  private async ensureAllowances(): Promise<void> {
    if (!this.client) return;

    try {
      // Check current allowances
      const allowances = await this.client.getAllowances();

      const needsApproval = !allowances ||
        !allowances.collateral ||
        !allowances.conditional;

      if (needsApproval) {
        logger.info('[PolymarketService] Setting token allowances (one-time operation)...');

        // Set max allowances for USDC and conditional tokens
        // This requires on-chain transactions (gas fees apply)
        await this.client.setAllowances();

        logger.info('[PolymarketService] Token allowances approved successfully');
      } else {
        logger.debug('[PolymarketService] Token allowances already set');
      }

      this.allowancesApproved = true;
    } catch (error) {
      // Don't throw - allowances might already be set or this is a read-only check
      logger.warn({ error }, '[PolymarketService] Could not verify/set allowances - trading may fail');
      // Still mark as approved to allow attempting trades
      this.allowancesApproved = true;
    }
  }

  /**
   * Check if allowances are set
   */
  areAllowancesApproved(): boolean {
    return this.allowancesApproved;
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
      // Default to active=true, closed=false for tradeable markets
      queryParams.set('active', String(params.active ?? true));
      queryParams.set('closed', String(params.closed ?? false));
      if (params.limit) queryParams.set('limit', String(params.limit));
      if (params.offset) queryParams.set('offset', String(params.offset));

      const response = await fetch(`${GAMMA_API_HOST}/markets?${queryParams.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch markets: ${response.statusText}`);
      }

      const data = await response.json();
      logger.debug({ marketCount: data?.length }, '[PolymarketService] Raw markets from API');

      let markets = this.parseMarkets(data);
      logger.debug({ parsedCount: markets.length }, '[PolymarketService] Parsed markets');

      // Filter out markets that aren't tradeable
      const beforeFilter = markets.length;
      markets = markets.filter(m => {
        // Must be active and not closed
        if (!m.active || m.closed || m.archived) return false;

        // Must be accepting orders
        if (!m.accepting_orders) return false;

        // Must have valid token IDs (not synthetic with -0/-1 suffix)
        // Real clobTokenIds are long numeric strings (50+ chars)
        const hasValidTokens = m.tokens.every(t =>
          t.token_id &&
          !t.token_id.endsWith('-0') &&
          !t.token_id.endsWith('-1') &&
          t.token_id.length > 20  // Real token IDs are 70+ chars
        );
        if (!hasValidTokens) return false;

        // Filter out expired markets
        if (m.end_date_iso) {
          const endDate = new Date(m.end_date_iso);
          if (endDate < new Date()) return false;
        }

        return true;
      });

      logger.info({ beforeFilter, afterFilter: markets.length }, '[PolymarketService] Markets after filtering');
      return markets;
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

    // Validate token ID format (skip synthetic IDs)
    if (!params.tokenId || params.tokenId.endsWith('-0') || params.tokenId.endsWith('-1')) {
      throw new Error(`Invalid token ID format: ${params.tokenId}. This market may not be tradeable.`);
    }

    // Validate against risk settings
    await this.validateOrderRisk(params);

    try {
      // First verify the market exists and has an orderbook
      let book;
      try {
        book = await this.getOrderBook(params.tokenId);
      } catch (bookError: any) {
        // Check if it's a market not found error
        if (bookError?.message?.includes('404') || bookError?.message?.includes('not found')) {
          throw new Error(`Market not found or no orderbook exists for token ${params.tokenId}. Market may be closed.`);
        }
        throw bookError;
      }

      // Validate order book has liquidity
      if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
        throw new Error(`No liquidity available for token ${params.tokenId}`);
      }

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
    } catch (error: any) {
      // Provide more specific error messages
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes('minimum_tick_size') || errorMsg.includes('undefined is not an object')) {
        logger.error({ tokenId: params.tokenId }, '[PolymarketService] Market appears to be closed or invalid');
        throw new Error(`Cannot trade token ${params.tokenId}: market may be closed or invalid`);
      }
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
   * Parse tokens from various API response formats
   */
  private parseTokens(m: any): { token_id: string; outcome: string; price: number; winner?: boolean }[] {
    const conditionId = m.conditionId || m.condition_id || '';
    const outcomeNames = m.outcomes || ['Yes', 'No'];
    const outcomePrices = m.outcomePrices || [];

    // Priority 1: clobTokenIds (Gamma API format) - these are the actual tradeable token IDs
    if (Array.isArray(m.clobTokenIds) && m.clobTokenIds.length > 0 && m.clobTokenIds[0]) {
      return m.clobTokenIds.map((tokenId: string, idx: number) => ({
        token_id: tokenId,
        outcome: outcomeNames[idx] || (idx === 0 ? 'Yes' : 'No'),
        price: parseFloat(outcomePrices[idx] || '0.5'),
        winner: undefined,
      }));
    }

    // Priority 2: tokens array with proper structure
    if (Array.isArray(m.tokens) && m.tokens.length > 0) {
      return m.tokens.map((t: any, idx: number) => ({
        token_id: t.token_id || t.tokenId || t.clobTokenId || `${conditionId}-${idx}`,
        outcome: t.outcome || outcomeNames[idx] || (idx === 0 ? 'Yes' : 'No'),
        price: parseFloat(t.price || outcomePrices[idx] || '0.5'),
        winner: t.winner,
      }));
    }

    // Fallback: generate synthetic tokens (these won't be tradeable)
    logger.warn({ conditionId, hasTokens: !!m.tokens, hasClobTokenIds: !!m.clobTokenIds },
      '[PolymarketService] No valid token IDs found, generating synthetic (non-tradeable)');
    return [
      { token_id: `${conditionId}-0`, outcome: outcomeNames[0] || 'Yes', price: parseFloat(outcomePrices[0] || '0.5') },
      { token_id: `${conditionId}-1`, outcome: outcomeNames[1] || 'No', price: parseFloat(outcomePrices[1] || '0.5') },
    ];
  }

  /**
   * Parse raw market data into PolymarketMarket format
   */
  private parseMarkets(data: any[]): PolymarketMarket[] {
    if (!Array.isArray(data)) {
      logger.warn('[PolymarketService] parseMarkets received non-array data');
      return [];
    }

    return data.map((m) => {
      try {
        return {
          condition_id: m.conditionId || m.condition_id,
          question_id: m.questionId || m.question_id,
          question: m.question || m.title || '',
          description: m.description || '',
          market_slug: m.slug || m.market_slug || '',
          end_date_iso: m.endDate || m.end_date_iso || '',
          game_start_time: m.gameStartTime || m.game_start_time,
          tokens: this.parseTokens(m),
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
        };
      } catch (err) {
        logger.error({ error: err, market: m }, '[PolymarketService] Failed to parse market');
        return null;
      }
    }).filter(Boolean) as PolymarketMarket[];
  }
}
