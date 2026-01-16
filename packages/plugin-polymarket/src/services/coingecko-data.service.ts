/**
 * CoinGecko Data Service
 *
 * Comprehensive CoinGecko API wrapper for crypto price data.
 * Provides real-time prices, OHLC data, market charts, and more.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';

// ============= Types =============

export interface PriceData {
  usd: number;
  usd_24h_change: number;
  usd_24h_vol: number;
  usd_market_cap: number;
  last_updated_at?: number;
}

export interface OHLCCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketChartData {
  prices: [number, number][];
  market_caps: [number, number][];
  total_volumes: [number, number][];
}

export interface CoinMarketData {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d_in_currency?: number;
  price_change_percentage_14d_in_currency?: number;
  price_change_percentage_30d_in_currency?: number;
  ath: number;
  ath_change_percentage: number;
  ath_date: string;
  atl: number;
  atl_change_percentage: number;
  atl_date: string;
}

export interface CoinDetail {
  id: string;
  symbol: string;
  name: string;
  market_data: {
    current_price: { usd: number };
    ath: { usd: number };
    ath_change_percentage: { usd: number };
    ath_date: { usd: string };
    atl: { usd: number };
    atl_change_percentage: { usd: number };
    atl_date: { usd: string };
    market_cap: { usd: number };
    total_volume: { usd: number };
    high_24h: { usd: number };
    low_24h: { usd: number };
    price_change_24h: number;
    price_change_percentage_24h: number;
    price_change_percentage_7d: number;
    price_change_percentage_14d: number;
    price_change_percentage_30d: number;
    price_change_percentage_60d: number;
    price_change_percentage_200d: number;
    price_change_percentage_1y: number;
    circulating_supply: number;
    total_supply: number;
    max_supply: number | null;
  };
}

export interface FullAnalysisData {
  price: PriceData;
  ohlc7d: OHLCCandle[];
  ohlc30d: OHLCCandle[];
  ohlc90d: OHLCCandle[];
  marketChart30d: MarketChartData;
  detail: CoinDetail;
}

export interface GlobalData {
  total_market_cap: { usd: number };
  total_volume: { usd: number };
  market_cap_percentage: { btc: number; eth: number };
  market_cap_change_percentage_24h_usd: number;
}

// ============= Configuration =============

export const COINGECKO_CONFIG = {
  // Tracked coins for price betting
  trackedCoins: [
    'bitcoin', 'ethereum', 'solana', 'ripple', 'cardano',
    'dogecoin', 'avalanche-2', 'chainlink', 'polkadot', 'matic-network',
    'litecoin', 'uniswap', 'stellar', 'cosmos', 'near'
  ],

  // OHLC intervals for different analysis timeframes
  ohlcDays: {
    shortTerm: 7,    // 30-min candles
    mediumTerm: 30,  // 4-hour candles
    longTerm: 90     // daily candles
  },

  // Cache TTL in milliseconds
  cacheTTL: {
    price: 30000,      // 30 seconds for prices
    ohlc: 300000,      // 5 minutes for OHLC
    detail: 600000,    // 10 minutes for details
    global: 60000      // 1 minute for global
  }
};

// ============= Service =============

export class CoinGeckoDataService extends Service {
  static readonly serviceType = 'coingecko-data';
  readonly capabilityDescription = 'Provides comprehensive CoinGecko crypto data for technical analysis';

  private runtime: IAgentRuntime | null = null;
  private baseUrl: string = 'https://api.coingecko.com/api/v3';
  private apiKey: string | null = null;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();

  static async start(runtime: IAgentRuntime): Promise<CoinGeckoDataService> {
    const service = new CoinGeckoDataService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info('[CoinGeckoData] Initializing CoinGecko data service');

    // Get API key from environment
    this.apiKey = process.env.COINGECKO_API_KEY ||
                  runtime.getSetting('COINGECKO_API_KEY') || null;

    // Use Pro API if key starts with 'CG-'
    if (this.apiKey && this.apiKey.startsWith('CG-')) {
      this.baseUrl = 'https://pro-api.coingecko.com/api/v3';
      logger.info('[CoinGeckoData] Using Pro API endpoint');
    }

    logger.info('[CoinGeckoData] Service initialized', {
      hasApiKey: !!this.apiKey,
      baseUrl: this.baseUrl
    });
  }

  async stop(): Promise<void> {
    this.cache.clear();
    logger.info('[CoinGeckoData] Service stopped');
  }

  // ============= Private Helpers =============

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (this.apiKey) {
      if (this.apiKey.startsWith('CG-')) {
        h['x-cg-pro-api-key'] = this.apiKey;
      } else {
        h['x-cg-demo-api-key'] = this.apiKey;
      }
    }
    return h;
  }

  private getCached<T>(key: string, ttl: number): T | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.data as T;
    }
    return null;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  private async fetchWithRetry<T>(url: string, ttlKey: string, ttl: number): Promise<T | null> {
    // Check cache first
    const cached = this.getCached<T>(ttlKey, ttl);
    if (cached) return cached;

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, { headers: this.headers });

        if (response.status === 429) {
          // Rate limited - wait and retry
          logger.warn('[CoinGeckoData] Rate limited, waiting...');
          await new Promise(r => setTimeout(r, RETRY_DELAY * attempt));
          continue;
        }

        if (!response.ok) {
          logger.warn({ status: response.status, url }, '[CoinGeckoData] API error');
          return null;
        }

        const data = await response.json();
        this.setCache(ttlKey, data);
        return data as T;
      } catch (error) {
        logger.warn({ error: String(error), attempt }, '[CoinGeckoData] Fetch failed');
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
      }
    }

    return null;
  }

  // ============= API Endpoints =============

  /**
   * Get simple price data for multiple coins
   */
  async getSimplePrice(coinIds: string[]): Promise<Record<string, PriceData>> {
    const params = new URLSearchParams({
      ids: coinIds.join(','),
      vs_currencies: 'usd',
      include_24hr_change: 'true',
      include_24hr_vol: 'true',
      include_market_cap: 'true',
      include_last_updated_at: 'true'
    });

    const cacheKey = `simple_price_${coinIds.sort().join(',')}`;
    const url = `${this.baseUrl}/simple/price?${params}`;

    const data = await this.fetchWithRetry<Record<string, any>>(
      url, cacheKey, COINGECKO_CONFIG.cacheTTL.price
    );

    if (!data) return {};

    // Transform to our interface
    const result: Record<string, PriceData> = {};
    for (const [coinId, priceData] of Object.entries(data)) {
      result[coinId] = {
        usd: priceData.usd || 0,
        usd_24h_change: priceData.usd_24h_change || 0,
        usd_24h_vol: priceData.usd_24h_vol || 0,
        usd_market_cap: priceData.usd_market_cap || 0,
        last_updated_at: priceData.last_updated_at
      };
    }

    return result;
  }

  /**
   * Get OHLC candlestick data
   */
  async getOHLC(coinId: string, days: number): Promise<OHLCCandle[]> {
    const params = new URLSearchParams({
      vs_currency: 'usd',
      days: days.toString()
    });

    const cacheKey = `ohlc_${coinId}_${days}`;
    const url = `${this.baseUrl}/coins/${coinId}/ohlc?${params}`;

    const data = await this.fetchWithRetry<number[][]>(
      url, cacheKey, COINGECKO_CONFIG.cacheTTL.ohlc
    );

    if (!data || !Array.isArray(data)) return [];

    return data.map((c: number[]) => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4]
    }));
  }

  /**
   * Get historical market chart data
   */
  async getMarketChart(coinId: string, days: number): Promise<MarketChartData | null> {
    const params = new URLSearchParams({
      vs_currency: 'usd',
      days: days.toString(),
      interval: days <= 1 ? 'hourly' : 'daily'
    });

    const cacheKey = `market_chart_${coinId}_${days}`;
    const url = `${this.baseUrl}/coins/${coinId}/market_chart?${params}`;

    return this.fetchWithRetry<MarketChartData>(
      url, cacheKey, COINGECKO_CONFIG.cacheTTL.ohlc
    );
  }

  /**
   * Get detailed coin market data (bulk)
   */
  async getCoinsMarkets(coinIds: string[]): Promise<CoinMarketData[]> {
    const params = new URLSearchParams({
      vs_currency: 'usd',
      ids: coinIds.join(','),
      order: 'market_cap_desc',
      sparkline: 'false',
      price_change_percentage: '24h,7d,14d,30d'
    });

    const cacheKey = `coins_markets_${coinIds.sort().join(',')}`;
    const url = `${this.baseUrl}/coins/markets?${params}`;

    const data = await this.fetchWithRetry<CoinMarketData[]>(
      url, cacheKey, COINGECKO_CONFIG.cacheTTL.price
    );

    return data || [];
  }

  /**
   * Get full coin detail including ATH/ATL
   */
  async getCoinDetail(coinId: string): Promise<CoinDetail | null> {
    const params = new URLSearchParams({
      localization: 'false',
      tickers: 'false',
      market_data: 'true',
      community_data: 'false',
      developer_data: 'false'
    });

    const cacheKey = `coin_detail_${coinId}`;
    const url = `${this.baseUrl}/coins/${coinId}?${params}`;

    return this.fetchWithRetry<CoinDetail>(
      url, cacheKey, COINGECKO_CONFIG.cacheTTL.detail
    );
  }

  /**
   * Get trending coins (sentiment indicator)
   */
  async getTrending(): Promise<{ coins: Array<{ item: { id: string; name: string; symbol: string; market_cap_rank: number } }> }> {
    const cacheKey = 'trending';
    const url = `${this.baseUrl}/search/trending`;

    const data = await this.fetchWithRetry<any>(
      url, cacheKey, COINGECKO_CONFIG.cacheTTL.global
    );

    return data || { coins: [] };
  }

  /**
   * Get global market data
   */
  async getGlobalData(): Promise<GlobalData | null> {
    const cacheKey = 'global';
    const url = `${this.baseUrl}/global`;

    const data = await this.fetchWithRetry<{ data: GlobalData }>(
      url, cacheKey, COINGECKO_CONFIG.cacheTTL.global
    );

    return data?.data || null;
  }

  // ============= Aggregated Data =============

  /**
   * Get all data needed for comprehensive technical analysis
   */
  async getFullAnalysisData(coinId: string): Promise<FullAnalysisData | null> {
    logger.info({ coinId }, '[CoinGeckoData] Fetching full analysis data');

    try {
      // Fetch all data in parallel
      const [prices, ohlc7d, ohlc30d, ohlc90d, marketChart30d, detail] = await Promise.all([
        this.getSimplePrice([coinId]),
        this.getOHLC(coinId, 7),
        this.getOHLC(coinId, 30),
        this.getOHLC(coinId, 90),
        this.getMarketChart(coinId, 30),
        this.getCoinDetail(coinId)
      ]);

      if (!prices[coinId] || !detail) {
        logger.warn({ coinId }, '[CoinGeckoData] Failed to fetch required data');
        return null;
      }

      return {
        price: prices[coinId],
        ohlc7d,
        ohlc30d,
        ohlc90d,
        marketChart30d: marketChart30d || { prices: [], market_caps: [], total_volumes: [] },
        detail
      };
    } catch (error) {
      logger.error({ error: String(error), coinId }, '[CoinGeckoData] Error fetching analysis data');
      return null;
    }
  }

  /**
   * Get prices for all tracked coins
   */
  async getAllTrackedPrices(): Promise<Record<string, PriceData>> {
    return this.getSimplePrice(COINGECKO_CONFIG.trackedCoins);
  }

  /**
   * Get market data for all tracked coins
   */
  async getAllTrackedMarkets(): Promise<CoinMarketData[]> {
    return this.getCoinsMarkets(COINGECKO_CONFIG.trackedCoins);
  }
}
