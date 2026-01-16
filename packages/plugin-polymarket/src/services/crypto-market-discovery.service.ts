/**
 * Crypto Market Discovery Service
 *
 * Discovers and filters Polymarket markets to ONLY crypto price prediction markets.
 * No politics, no sports, no general events - just crypto price betting.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';

// ============= Types =============

export interface CryptoPriceMarket {
  // Market identifiers
  id: string;
  question: string;
  conditionId: string;
  slug: string;

  // Crypto specifics
  coin: string;           // CoinGecko coin ID (e.g., 'bitcoin')
  coinSymbol: string;     // Symbol (e.g., 'BTC')
  targetPrice: number;    // Price threshold (e.g., 100000)
  direction: 'ABOVE' | 'BELOW' | 'REACH';

  // Timing
  endDate: Date;
  daysToExpiry: number;

  // Market data
  yesPrice: number;       // Current YES price (0.00-1.00)
  noPrice: number;        // Current NO price
  impliedProbability: number;  // YES price as probability
  volume24h: number;
  totalVolume: number;
  liquidity: number;

  // Token IDs for trading
  yesTokenId: string;
  noTokenId: string;
}

// ============= Configuration =============

const CRYPTO_KEYWORDS = {
  // Coin name to CoinGecko ID mapping
  coins: {
    'bitcoin': ['bitcoin', 'btc'],
    'ethereum': ['ethereum', 'eth', 'ether'],
    'solana': ['solana', 'sol'],
    'ripple': ['xrp', 'ripple'],
    'cardano': ['cardano', 'ada'],
    'dogecoin': ['dogecoin', 'doge'],
    'avalanche-2': ['avalanche', 'avax'],
    'chainlink': ['chainlink', 'link'],
    'polkadot': ['polkadot', 'dot'],
    'matic-network': ['polygon', 'matic'],
    'litecoin': ['litecoin', 'ltc'],
    'uniswap': ['uniswap', 'uni'],
    'stellar': ['stellar', 'xlm'],
    'cosmos': ['cosmos', 'atom'],
    'near': ['near', 'near protocol'],
    'arbitrum': ['arbitrum', 'arb'],
    'optimism': ['optimism', 'op'],
    'aptos': ['aptos', 'apt'],
    'sui': ['sui'],
    'pepe': ['pepe'],
    'shiba-inu': ['shiba', 'shib'],
    'toncoin': ['toncoin', 'ton'],
    'bonk': ['bonk']
  } as Record<string, string[]>,

  // Price patterns to match
  pricePatterns: [
    /\$([\d,]+(?:\.\d+)?)(k|m|b)?/i,                           // $100,000 or $100k
    /([\d,]+(?:\.\d+)?)\s*(?:usd|dollars?|bucks)/i,            // 100000 USD
    /(?:above|below|reach|hit|exceed|at or above)\s*\$([\d,]+)/i,  // above $100k
    /price\s*(?:of|at)?\s*\$([\d,]+)/i                         // price of $100k
  ],

  // Keywords that MUST be present (at least one)
  includeKeywords: [
    'price', 'above', 'below', 'reach', 'hit', 'exceed',
    'ath', 'all-time high', 'all time high', 'new high',
    '$', 'usd', 'dollars', 'worth'
  ],

  // Keywords that MUST NOT be present (excludes non-price markets)
  excludeKeywords: [
    // Regulatory/Legal
    'etf', 'approval', 'approve', 'sec', 'regulation', 'regulated', 'ban', 'banned',
    'lawsuit', 'sue', 'legal', 'court', 'judge', 'ruling',

    // Exchange/Company events
    'hack', 'hacked', 'exchange', 'ceo', 'founder', 'arrest', 'arrested',
    'shutdown', 'delist', 'delisted', 'bankrupt', 'bankruptcy', 'insolvent',
    'resign', 'fired', 'step down',

    // Political/General
    'trump', 'biden', 'election', 'president', 'congress', 'senate',
    'war', 'invasion', 'nato', 'ukraine', 'russia', 'china',

    // Sports
    'super bowl', 'nfl', 'nba', 'mlb', 'world cup', 'championship',
    'playoffs', 'finals', 'game', 'match', 'team',

    // Other non-price
    'tweet', 'post', 'announce', 'announcement', 'meeting', 'conference',
    'halving',  // Usually about the event, not price
    'reserve', 'strategic', 'government', 'adopt', 'adoption'
  ]
};

const GAMMA_API_HOST = 'https://gamma-api.polymarket.com';

// ============= Service =============

export class CryptoMarketDiscoveryService extends Service {
  static readonly serviceType = 'crypto-market-discovery';
  readonly capabilityDescription = 'Discovers crypto price prediction markets on Polymarket';

  private runtime: IAgentRuntime | null = null;

  static async start(runtime: IAgentRuntime): Promise<CryptoMarketDiscoveryService> {
    const service = new CryptoMarketDiscoveryService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info('[CryptoMarketDiscovery] Service initialized');
  }

  async stop(): Promise<void> {
    logger.info('[CryptoMarketDiscovery] Service stopped');
  }

  // ============= Market Fetching =============

  /**
   * Fetch all active markets from Polymarket
   */
  private async fetchAllActiveMarkets(limit: number = 500): Promise<any[]> {
    const markets: any[] = [];
    let offset = 0;
    const batchSize = 100;

    logger.info({ limit }, '[CryptoMarketDiscovery] Fetching active markets');

    while (markets.length < limit) {
      try {
        const params = new URLSearchParams({
          active: 'true',
          closed: 'false',
          end_date_min: new Date().toISOString(),
          limit: batchSize.toString(),
          offset: offset.toString(),
          order: 'volume24hr',
          ascending: 'false'
        });

        const response = await fetch(`${GAMMA_API_HOST}/markets?${params}`);

        if (!response.ok) {
          logger.warn({ status: response.status }, '[CryptoMarketDiscovery] API error');
          break;
        }

        const batch = await response.json();

        if (!batch || !Array.isArray(batch) || batch.length === 0) break;

        markets.push(...batch);
        offset += batchSize;

        if (batch.length < batchSize) break;

        // Rate limiting
        await new Promise(r => setTimeout(r, 100));
      } catch (error) {
        logger.error({ error: String(error) }, '[CryptoMarketDiscovery] Fetch error');
        break;
      }
    }

    logger.info({ count: markets.length }, '[CryptoMarketDiscovery] Fetched markets');
    return markets;
  }

  // ============= Market Filtering =============

  /**
   * Detect which cryptocurrency a market is about
   */
  private detectCoin(question: string): { id: string; symbol: string } | null {
    const q = question.toLowerCase();

    for (const [coinId, keywords] of Object.entries(CRYPTO_KEYWORDS.coins)) {
      for (const keyword of keywords) {
        // Match whole word to avoid false positives
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(q)) {
          return {
            id: coinId,
            symbol: keywords[keywords.length - 1].toUpperCase()
          };
        }
      }
    }

    return null;
  }

  /**
   * Extract price target from market question
   */
  private extractPriceTarget(question: string): number | null {
    for (const pattern of CRYPTO_KEYWORDS.pricePatterns) {
      const match = question.match(pattern);
      if (match) {
        let priceStr = match[1].replace(/,/g, '');
        let price = parseFloat(priceStr);

        // Handle suffixes (k, m, b)
        const suffix = match[2]?.toLowerCase();
        if (suffix === 'k') price *= 1000;
        else if (suffix === 'm') price *= 1000000;
        else if (suffix === 'b') price *= 1000000000;

        if (!isNaN(price) && price > 0) {
          return price;
        }
      }
    }
    return null;
  }

  /**
   * Determine price direction from question
   */
  private extractDirection(question: string): 'ABOVE' | 'BELOW' | 'REACH' {
    const q = question.toLowerCase();

    if (q.includes('below') || q.includes('under') || q.includes('fall below') || q.includes('drop below')) {
      return 'BELOW';
    }
    if (q.includes('above') || q.includes('over') || q.includes('exceed') || q.includes('at or above') || q.includes('higher than')) {
      return 'ABOVE';
    }
    // Default for "reach", "hit", "touch", etc.
    return 'REACH';
  }

  /**
   * Check if market is a valid crypto price market
   */
  private isCryptoPriceMarket(question: string): boolean {
    const q = question.toLowerCase();

    // Must have a crypto coin
    const coin = this.detectCoin(question);
    if (!coin) return false;

    // Must have at least one price-related keyword
    const hasPriceKeyword = CRYPTO_KEYWORDS.includeKeywords.some(kw =>
      q.includes(kw.toLowerCase())
    );
    if (!hasPriceKeyword) return false;

    // Must NOT have excluded keywords
    const hasExcluded = CRYPTO_KEYWORDS.excludeKeywords.some(kw =>
      q.includes(kw.toLowerCase())
    );
    if (hasExcluded) return false;

    // Must have a price target
    const priceTarget = this.extractPriceTarget(question);
    if (!priceTarget) return false;

    return true;
  }

  /**
   * Parse raw market data into CryptoPriceMarket
   */
  private parseMarket(market: any): CryptoPriceMarket | null {
    const question = market.question || '';

    // Detect coin
    const coin = this.detectCoin(question);
    if (!coin) return null;

    // Extract price target
    const targetPrice = this.extractPriceTarget(question);
    if (!targetPrice) return null;

    // Extract direction
    const direction = this.extractDirection(question);

    // Parse dates
    const endDate = new Date(market.endDate || market.end_date_iso);
    const daysToExpiry = Math.max(0.1, (endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    // Parse prices
    let yesPrice = 0.5;
    let noPrice = 0.5;
    try {
      const outcomePrices = market.outcomePrices
        ? JSON.parse(market.outcomePrices)
        : [0.5, 0.5];
      yesPrice = parseFloat(outcomePrices[0]) || 0.5;
      noPrice = parseFloat(outcomePrices[1]) || 0.5;
    } catch {
      // Use defaults
    }

    // Parse token IDs
    let yesTokenId = '';
    let noTokenId = '';
    try {
      const tokenIds = market.clobTokenIds
        ? (typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds)
        : [];
      yesTokenId = tokenIds[0] || '';
      noTokenId = tokenIds[1] || '';
    } catch {
      // Use defaults
    }

    return {
      id: market.id || market.conditionId || market.condition_id,
      question,
      conditionId: market.conditionId || market.condition_id || '',
      slug: market.slug || market.market_slug || '',

      coin: coin.id,
      coinSymbol: coin.symbol,
      targetPrice,
      direction,

      endDate,
      daysToExpiry,

      yesPrice,
      noPrice,
      impliedProbability: yesPrice,
      volume24h: parseFloat(market.volume24hr || market.volume_num || '0') || 0,
      totalVolume: parseFloat(market.volume || market.volumeNum || '0') || 0,
      liquidity: parseFloat(market.liquidityNum || market.liquidity || '0') || 0,

      yesTokenId,
      noTokenId
    };
  }

  // ============= Public API =============

  /**
   * Get all crypto price prediction markets
   */
  async getCryptoPriceMarkets(minVolume: number = 0, minLiquidity: number = 0): Promise<CryptoPriceMarket[]> {
    logger.info('[CryptoMarketDiscovery] Scanning for crypto price markets');

    // Fetch all markets
    const allMarkets = await this.fetchAllActiveMarkets(500);

    // Filter to crypto price markets only
    const cryptoMarkets: CryptoPriceMarket[] = [];

    for (const market of allMarkets) {
      const question = market.question || '';

      // Check if it's a crypto price market
      if (!this.isCryptoPriceMarket(question)) continue;

      // Parse the market
      const parsed = this.parseMarket(market);
      if (!parsed) continue;

      // Apply filters
      if (parsed.volume24h < minVolume) continue;
      if (parsed.liquidity < minLiquidity) continue;

      cryptoMarkets.push(parsed);
    }

    // Sort by 24h volume
    cryptoMarkets.sort((a, b) => b.volume24h - a.volume24h);

    logger.info({
      total: allMarkets.length,
      crypto: cryptoMarkets.length,
      coins: [...new Set(cryptoMarkets.map(m => m.coinSymbol))]
    }, '[CryptoMarketDiscovery] Found crypto price markets');

    return cryptoMarkets;
  }

  /**
   * Get crypto price markets for a specific coin
   */
  async getMarketsForCoin(coinId: string): Promise<CryptoPriceMarket[]> {
    const allMarkets = await this.getCryptoPriceMarkets();
    return allMarkets.filter(m => m.coin === coinId);
  }

  /**
   * Get markets expiring within N days
   */
  async getExpiringMarkets(maxDays: number): Promise<CryptoPriceMarket[]> {
    const allMarkets = await this.getCryptoPriceMarkets();
    return allMarkets.filter(m => m.daysToExpiry <= maxDays);
  }

  /**
   * Get high-liquidity markets
   */
  async getHighLiquidityMarkets(minLiquidity: number = 10000): Promise<CryptoPriceMarket[]> {
    return this.getCryptoPriceMarkets(0, minLiquidity);
  }

  /**
   * Search markets by keyword
   */
  async searchMarkets(keyword: string): Promise<CryptoPriceMarket[]> {
    const allMarkets = await this.getCryptoPriceMarkets();
    const kw = keyword.toLowerCase();
    return allMarkets.filter(m =>
      m.question.toLowerCase().includes(kw) ||
      m.coin.toLowerCase().includes(kw) ||
      m.coinSymbol.toLowerCase().includes(kw)
    );
  }

  /**
   * Get unique coins with active markets
   */
  async getActiveCoins(): Promise<string[]> {
    const markets = await this.getCryptoPriceMarkets();
    return [...new Set(markets.map(m => m.coin))];
  }
}
