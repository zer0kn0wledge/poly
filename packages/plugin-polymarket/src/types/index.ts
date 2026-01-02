/**
 * Polymarket Plugin Types
 */

/**
 * Order side - buy or sell
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Order type for the CLOB
 */
export type OrderType = 'GTC' | 'FOK' | 'FAK';

/**
 * Polymarket market outcome token
 */
export interface OutcomeToken {
  token_id: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

/**
 * Polymarket market data
 */
export interface PolymarketMarket {
  condition_id: string;
  question_id: string;
  question: string;
  description: string;
  market_slug: string;
  end_date_iso: string;
  game_start_time?: string;
  tokens: OutcomeToken[];
  active: boolean;
  closed: boolean;
  archived: boolean;
  accepting_orders: boolean;
  accepting_order_timestamp?: string;
  minimum_order_size: number;
  minimum_tick_size: number;
  neg_risk: boolean;
  volume: number;
  volume_num: number;
  liquidity: number;
  spread: number;
}

/**
 * User position in a market
 */
export interface PolymarketPosition {
  market: PolymarketMarket;
  outcome: string;
  token_id: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

/**
 * Order placement parameters
 */
export interface PlaceOrderParams {
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  orderType?: OrderType;
}

/**
 * Order result
 */
export interface OrderResult {
  orderId: string;
  status: 'pending' | 'matched' | 'cancelled' | 'failed';
  filledSize: number;
  remainingSize: number;
  avgFillPrice: number;
  transactionHash?: string;
}

/**
 * Trade history entry
 */
export interface TradeEntry {
  id: string;
  market: string;
  outcome: string;
  side: OrderSide;
  price: number;
  size: number;
  timestamp: Date;
  transactionHash: string;
}

/**
 * Portfolio summary
 */
export interface PolymarketPortfolio {
  totalValue: number;
  cashBalance: number;
  positions: PolymarketPosition[];
  unrealizedPnl: number;
  realizedPnl: number;
}

/**
 * Risk management settings
 */
export interface RiskSettings {
  maxPositionSize: number;
  maxPortfolioRisk: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  maxDailyLoss: number;
  allowedMarketCategories?: string[];
  blockedMarkets?: string[];
}

/**
 * Plugin configuration
 */
export interface PolymarketConfig {
  privateKey: string;
  chainId?: number;
  host?: string;
  riskSettings?: RiskSettings;
}

/**
 * API credentials for L2 authentication
 */
export interface ApiCredentials {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

/**
 * Market search parameters
 */
export interface MarketSearchParams {
  query?: string;
  active?: boolean;
  closed?: boolean;
  limit?: number;
  offset?: number;
  /** If true, include markets in resolution phase (>95% skewed odds) */
  includeResolution?: boolean;
  /** If true, skip end_date_min filtering to view past markets */
  skipDateFilter?: boolean;
}

/**
 * Order book entry
 */
export interface OrderBookEntry {
  price: number;
  size: number;
}

/**
 * Order book for a market
 */
export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  spread: number;
  midpoint: number;
}
