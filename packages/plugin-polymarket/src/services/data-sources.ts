/**
 * Data Sources Service
 *
 * Aggregates multiple data APIs for market intelligence:
 * - Tavily (real-time web search)
 * - CryptoPanic (crypto news)
 * - CoinGecko (crypto prices)
 * - DeFiLlama (DeFi data)
 * - SportMonks (sports data)
 * - Twitter (social signals)
 * - News scraping (politics, economy, geopolitics)
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';

// ============= Fetch with Timeout =============

const DEFAULT_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Fetch with timeout to prevent hanging requests
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Safe fetch that returns null on error instead of throwing
 */
async function safeFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(url, options, timeoutMs);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      logger.warn({ url }, '[DataSources] Request timed out');
    } else {
      logger.debug({ error, url }, '[DataSources] Fetch failed');
    }
    return null;
  }
}

// ============= Types =============

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: Date;
  categories: string[];
  sentiment?: 'positive' | 'negative' | 'neutral';
  relevanceScore?: number;
  relatedMarkets?: string[];
}

export interface CryptoPrice {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  change7d: number;
  volume24h: number;
  marketCap: number;
}

export interface SportEvent {
  id: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: Date;
  odds?: {
    home: number;
    away: number;
    draw?: number;
  };
  status: 'upcoming' | 'live' | 'finished';
  score?: { home: number; away: number };
}

export interface TwitterSignal {
  id: string;
  author: string;
  authorFollowers: number;
  text: string;
  createdAt: Date;
  likes: number;
  retweets: number;
  sentiment?: 'bullish' | 'bearish' | 'neutral';
  topics: string[];
}

export interface MarketSignal {
  source: string;
  type: 'news' | 'social' | 'price' | 'sports' | 'politics' | 'web';
  strength: number; // 0-100
  direction: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  relatedMarkets: string[];
  timestamp: Date;
  rawData: unknown;
}

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  answer?: string;
  followUpQuestions?: string[];
}

// ============= News Sources Config =============

const NEWS_SOURCES = {
  politics: [
    'politico.com', 'thehill.com', 'axios.com', 'reuters.com/politics',
    'apnews.com/politics', 'washingtonpost.com', 'nytimes.com/politics',
    'bbc.com/news/politics', 'theguardian.com/politics', 'cnn.com/politics',
    'foxnews.com/politics', 'nbcnews.com/politics', 'cbsnews.com/politics',
    'abcnews.go.com/Politics', 'pbs.org/newshour/politics'
  ],
  economy: [
    'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com', 'marketwatch.com',
    'economist.com', 'reuters.com/business', 'forbes.com', 'businessinsider.com',
    'finance.yahoo.com', 'tradingeconomics.com', 'investing.com'
  ],
  geopolitics: [
    'foreignaffairs.com', 'foreignpolicy.com', 'aljazeera.com', 'bbc.com/news/world',
    'reuters.com/world', 'apnews.com/world-news', 'dw.com', 'france24.com',
    'scmp.com', 'rt.com', 'euronews.com', 'middleeasteye.net'
  ],
  crypto: [
    'coindesk.com', 'cointelegraph.com', 'theblock.co', 'decrypt.co',
    'cryptoslate.com', 'bitcoinmagazine.com', 'blockworks.co', 'defiant.io'
  ],
  sports: [
    'espn.com', 'bleacherreport.com', 'sportingnews.com', 'cbssports.com',
    'sports.yahoo.com', 'theathletic.com', 'si.com', 'foxsports.com',
    'nbcsports.com', 'skysports.com', 'bbc.com/sport'
  ],
  tech: [
    'techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com',
    'engadget.com', 'zdnet.com', 'venturebeat.com'
  ]
};

// Key Twitter accounts to monitor by category (10+ per vertical)
const TWITTER_ACCOUNTS = {
  politics: [
    'POTUS', 'WhiteHouse', 'SpeakerJohnson', 'LeaderJeffries',
    'Politico', 'thehill', 'axios', 'Nate_Cohn', 'redistrict',
    'NateSilver538', 'DecisionDeskHQ', 'CookPolitical', 'RealClearNews',
    'FiveThirtyEight', 'SteveKornacki', 'ElectionWiz'
  ],
  crypto: [
    'VitalikButerin', 'saylor', 'CryptoHayes', 'caborkie0x',
    'inversebrah', 'DegenSpartan', 'loomdart', 'trader_XO',
    'GCRClassic', 'CryptoCobain', 'lightcrypto', 'Pentosh1',
    'CroissantEth', 'DefiIgnas', 'Route2FI', 'milaborkDotEth'
  ],
  markets: [
    'zerohedge', 'DeItaone', 'Fxhedgers', 'unusual_whales',
    'FirstSquawk', 'LiveSquawk', 'jimcramer', 'Carl_C_Icahn',
    'NorthmanTrader', 'PeterSchiff', 'elerianm', 'Schuldensuehner',
    'GoldmanSachs', 'jpmorgan', 'Markets', 'FinancialTimes'
  ],
  sports: [
    'wojespn', 'ShamsCharania', 'AdamSchefter', 'RapSheet',
    'JeffPassan', 'FabrizioRomano', 'MarcJSpears', 'ChrisBHaynes',
    'FieldYates', 'JayGlazer', 'MikeGarafolo', 'JonathanJones',
    'Ken_Rosenthal', 'JonMorosi', 'wojespnNBA', 'WindhorstESPN'
  ],
  geopolitics: [
    'AFP', 'AJEnglish', 'BBCWorld', 'Reuters', 'AP',
    'France24_en', 'euronews', 'MiddleEastEye', 'Jerusalem_Post',
    'KyivIndependent', 'guardian', 'nytimes', 'SCMPNews'
  ],
  breaking_news: [
    'DeItaone', 'Fxhedgers', 'unusual_whales', 'disclosetv',
    'BNONews', 'spectaborindex', 'FirstSquawk', 'LiveSquawk',
    'BreakingNews', 'BBCBreaking', 'CNNBreaking', 'NewsLambert'
  ]
};

// ============= Service Implementation =============

export class DataSourcesService extends Service {
  static override readonly serviceType = 'data-sources';
  override capabilityDescription = 'Aggregates multiple data APIs for market intelligence';

  static async start(runtime: IAgentRuntime): Promise<DataSourcesService> {
    const service = new DataSourcesService();
    await service.initialize(runtime);
    return service;
  }

  private tavilyApiKey: string;
  private cryptoPanicKey: string;
  private coinGeckoKey: string;
  private defiLlamaKey: string;
  private sportMonksKey: string;
  private twitterClientId: string;
  private twitterClientSecret: string;

  private newsCache: Map<string, { data: NewsItem[]; timestamp: number }> = new Map();
  private priceCache: Map<string, { data: CryptoPrice; timestamp: number }> = new Map();
  private tavilyCache: Map<string, { data: TavilySearchResponse; timestamp: number }> = new Map();
  private signalBuffer: MarketSignal[] = [];

  private readonly CACHE_TTL = 60000; // 1 minute
  private readonly TAVILY_CACHE_TTL = 300000; // 5 minutes for web search results
  private readonly MAX_SIGNALS = 1000;

  constructor() {
    super();
    this.tavilyApiKey = process.env.TAVILY_API_KEY || '';
    this.cryptoPanicKey = process.env.CRYPTOPANIC_API_KEY || '';
    this.coinGeckoKey = process.env.COINGECKO_API_KEY || '';
    this.defiLlamaKey = process.env.DEFILLAMA_API_KEY || '';
    this.sportMonksKey = process.env.SPORTMONKS_API_KEY || '';
    this.twitterClientId = process.env.TWITTER_CLIENT_ID || '';
    this.twitterClientSecret = process.env.TWITTER_CLIENT_SECRET || '';
  }

  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[DataSources] Initializing data sources service');

    // Load keys from runtime config if not in env
    this.tavilyApiKey = this.tavilyApiKey || runtime.getSetting('TAVILY_API_KEY') || '';
    this.cryptoPanicKey = this.cryptoPanicKey || runtime.getSetting('CRYPTOPANIC_API_KEY') || '';
    this.coinGeckoKey = this.coinGeckoKey || runtime.getSetting('COINGECKO_API_KEY') || '';
    this.defiLlamaKey = this.defiLlamaKey || runtime.getSetting('DEFILLAMA_API_KEY') || '';
    this.sportMonksKey = this.sportMonksKey || runtime.getSetting('SPORTMONKS_API_KEY') || '';

    logger.info('[DataSources] Available data sources:', {
      tavily: !!this.tavilyApiKey,
      cryptoPanic: !!this.cryptoPanicKey,
      coinGecko: !!this.coinGeckoKey,
      defiLlama: !!this.defiLlamaKey,
      sportMonks: !!this.sportMonksKey,
      twitter: !!this.twitterClientId,
    });
  }

  override async stop(): Promise<void> {
    logger.info('[DataSources] Stopping data sources service');
    this.newsCache.clear();
    this.priceCache.clear();
    this.tavilyCache.clear();
    this.signalBuffer = [];
  }

  // ============= Tavily Web Search Integration =============

  /**
   * Search the web using Tavily for real-time context
   * @param query Search query
   * @param options Search options
   */
  async searchWeb(
    query: string,
    options: {
      searchDepth?: 'basic' | 'advanced';
      includeAnswer?: boolean;
      maxResults?: number;
      includeDomains?: string[];
      excludeDomains?: string[];
    } = {}
  ): Promise<TavilySearchResponse | null> {
    if (!this.tavilyApiKey) {
      logger.debug('[DataSources] Tavily API key not configured');
      return null;
    }

    // Check cache
    const cacheKey = `tavily-${query}-${JSON.stringify(options)}`;
    const cached = this.tavilyCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.TAVILY_CACHE_TTL) {
      return cached.data;
    }

    try {
      const response = await safeFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: this.tavilyApiKey,
          query,
          search_depth: options.searchDepth || 'basic',
          include_answer: options.includeAnswer ?? true,
          max_results: options.maxResults || 10,
          include_domains: options.includeDomains || [],
          exclude_domains: options.excludeDomains || [],
        }),
      });

      if (!response || !response.ok) {
        logger.warn({ status: response?.status }, '[DataSources] Tavily search failed');
        return null;
      }

      const data = await response.json();

      const result: TavilySearchResponse = {
        query,
        results: (data.results || []).map((r: any) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          score: r.score || 0,
          publishedDate: r.published_date,
        })),
        answer: data.answer,
        followUpQuestions: data.follow_up_questions,
      };

      this.tavilyCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      logger.error({ error }, '[DataSources] Tavily search error');
      return null;
    }
  }

  /**
   * Search for real-time context about a specific market topic
   * Automatically selects relevant domains based on topic category
   */
  async getMarketContext(
    topic: string,
    category: 'crypto' | 'politics' | 'sports' | 'economy' | 'geopolitics' | 'tech' | 'general' = 'general'
  ): Promise<{
    summary: string;
    sources: TavilySearchResult[];
    sentiment: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
  } | null> {
    // Select domains based on category
    const domainsByCategory: Record<string, string[]> = {
      crypto: ['coindesk.com', 'cointelegraph.com', 'theblock.co', 'decrypt.co', 'bloomberg.com'],
      politics: ['politico.com', 'thehill.com', 'reuters.com', 'apnews.com', 'bbc.com'],
      sports: ['espn.com', 'bleacherreport.com', 'theathletic.com', 'cbssports.com'],
      economy: ['bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'reuters.com'],
      geopolitics: ['foreignaffairs.com', 'reuters.com', 'bbc.com', 'aljazeera.com'],
      tech: ['techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com'],
      general: [],
    };

    const includeDomains = domainsByCategory[category] || [];

    const result = await this.searchWeb(topic, {
      searchDepth: 'advanced',
      includeAnswer: true,
      maxResults: 8,
      includeDomains: includeDomains.length > 0 ? includeDomains : undefined,
    });

    if (!result || result.results.length === 0) {
      return null;
    }

    // Analyze sentiment from content
    const sentiment = this.analyzeSentimentFromContent(result.results.map(r => r.content).join(' '));

    return {
      summary: result.answer || result.results[0].content.slice(0, 500),
      sources: result.results,
      sentiment: sentiment.direction,
      confidence: sentiment.confidence,
    };
  }

  /**
   * Simple sentiment analysis from text content
   */
  private analyzeSentimentFromContent(text: string): { direction: 'bullish' | 'bearish' | 'neutral'; confidence: number } {
    const lowerText = text.toLowerCase();

    // Bullish keywords
    const bullishKeywords = [
      'surge', 'rally', 'gain', 'rise', 'up', 'bullish', 'positive', 'growth',
      'breakthrough', 'success', 'win', 'winning', 'leading', 'ahead',
      'optimistic', 'strong', 'momentum', 'outperform', 'beat', 'exceed',
    ];

    // Bearish keywords
    const bearishKeywords = [
      'crash', 'plunge', 'drop', 'fall', 'down', 'bearish', 'negative', 'decline',
      'fail', 'failure', 'lose', 'losing', 'behind', 'trailing',
      'pessimistic', 'weak', 'slowdown', 'underperform', 'miss', 'concern',
    ];

    let bullishScore = 0;
    let bearishScore = 0;

    for (const keyword of bullishKeywords) {
      const matches = (lowerText.match(new RegExp(`\\b${keyword}\\b`, 'g')) || []).length;
      bullishScore += matches;
    }

    for (const keyword of bearishKeywords) {
      const matches = (lowerText.match(new RegExp(`\\b${keyword}\\b`, 'g')) || []).length;
      bearishScore += matches;
    }

    const totalScore = bullishScore + bearishScore;
    if (totalScore === 0) {
      return { direction: 'neutral', confidence: 50 };
    }

    const ratio = bullishScore / totalScore;
    if (ratio > 0.6) {
      return { direction: 'bullish', confidence: Math.min(90, 50 + ratio * 50) };
    } else if (ratio < 0.4) {
      return { direction: 'bearish', confidence: Math.min(90, 50 + (1 - ratio) * 50) };
    }

    return { direction: 'neutral', confidence: 60 };
  }

  // ============= CryptoPanic Integration =============

  async getCryptoNews(filter?: 'rising' | 'hot' | 'bullish' | 'bearish'): Promise<NewsItem[]> {
    const cacheKey = `cryptopanic-${filter || 'all'}`;
    const cached = this.newsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      // Skip if no API key
      if (!this.cryptoPanicKey) {
        logger.debug('[DataSources] CryptoPanic API key not configured');
        return [];
      }

      // CryptoPanic API v1 endpoint - same for all API keys
      // Only auth_token is required, filter is optional
      const params = new URLSearchParams({
        auth_token: this.cryptoPanicKey,
      });
      if (filter) params.append('filter', filter);

      const apiUrl = `https://cryptopanic.com/api/v1/posts/?${params}`;
      logger.debug({ url: apiUrl.replace(this.cryptoPanicKey, 'REDACTED') }, '[DataSources] Fetching CryptoPanic news');

      const response = await safeFetch(apiUrl);

      // Check if response exists and is OK before parsing
      if (!response) {
        logger.warn('[DataSources] CryptoPanic: No response received');
        return [];
      }
      if (!response.ok) {
        logger.warn({ status: response.status, statusText: response.statusText }, '[DataSources] CryptoPanic API error - check if API key is valid and endpoint is correct');
        return [];
      }

      // Try to parse JSON, handle non-JSON responses
      let data;
      try {
        const text = await response.text();
        data = JSON.parse(text);
      } catch (parseError) {
        logger.warn('[DataSources] CryptoPanic returned non-JSON response');
        return [];
      }

      // Check for API errors in response
      if (data.error || data.info) {
        logger.warn({ error: data.error, info: data.info }, '[DataSources] CryptoPanic API returned error');
        return [];
      }

      const news: NewsItem[] = (data.results || []).map((item: any) => ({
        id: item.id?.toString() || crypto.randomUUID(),
        title: item.title,
        summary: item.title, // CryptoPanic doesn't provide summary
        url: item.url,
        source: item.source?.title || 'CryptoPanic',
        publishedAt: new Date(item.published_at),
        categories: ['crypto'],
        sentiment: this.mapCryptoPanicSentiment(item.votes),
        relevanceScore: this.calculateRelevance(item),
      }));

      this.newsCache.set(cacheKey, { data: news, timestamp: Date.now() });
      return news;
    } catch (error) {
      logger.error({ error }, '[DataSources] CryptoPanic fetch failed');
      return [];
    }
  }

  private mapCryptoPanicSentiment(votes: any): 'positive' | 'negative' | 'neutral' {
    if (!votes) return 'neutral';
    const bullish = votes.positive || 0;
    const bearish = votes.negative || 0;
    if (bullish > bearish * 1.5) return 'positive';
    if (bearish > bullish * 1.5) return 'negative';
    return 'neutral';
  }

  private calculateRelevance(item: any): number {
    let score = 50;
    if (item.votes?.important) score += 20;
    if (item.votes?.liked) score += item.votes.liked * 2;
    if (item.votes?.positive) score += item.votes.positive * 3;
    return Math.min(100, score);
  }

  // ============= CoinGecko Integration =============

  private getCoinGeckoBaseUrl(): string {
    // Pro keys start with 'CG-' and require pro-api endpoint
    if (this.coinGeckoKey && this.coinGeckoKey.startsWith('CG-')) {
      return 'https://pro-api.coingecko.com/api/v3';
    }
    return 'https://api.coingecko.com/api/v3';
  }

  private getCoinGeckoHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.coinGeckoKey) {
      // Pro keys use x-cg-pro-api-key, demo keys use x-cg-demo-api-key
      if (this.coinGeckoKey.startsWith('CG-')) {
        headers['x-cg-pro-api-key'] = this.coinGeckoKey;
      } else {
        headers['x-cg-demo-api-key'] = this.coinGeckoKey;
      }
    }
    return headers;
  }

  async getCryptoPrices(coins: string[] = ['bitcoin', 'ethereum']): Promise<CryptoPrice[]> {
    try {
      const ids = coins.join(',');
      const baseUrl = this.getCoinGeckoBaseUrl();
      const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h,7d`;

      const headers = this.getCoinGeckoHeaders();

      const response = await safeFetch(url, { headers });
      if (!response) {
        return [];
      }

      const data = await response.json();

      // Handle error responses from CoinGecko API
      if (!response.ok || data?.error || data?.status?.error_code) {
        logger.warn({ status: response.status, error: data?.error || data?.status }, '[DataSources] CoinGecko API error');
        return [];
      }

      // Ensure data is an array before mapping
      if (!Array.isArray(data)) {
        logger.warn({ dataType: typeof data }, '[DataSources] CoinGecko returned non-array');
        return [];
      }

      return data.map((coin: any) => ({
        symbol: coin.symbol?.toUpperCase(),
        name: coin.name,
        price: coin.current_price,
        change24h: coin.price_change_percentage_24h,
        change7d: coin.price_change_percentage_7d_in_currency,
        volume24h: coin.total_volume,
        marketCap: coin.market_cap,
      }));
    } catch (error) {
      logger.error({ error }, '[DataSources] CoinGecko fetch failed');
      return [];
    }
  }

  async getTrendingCoins(): Promise<string[]> {
    try {
      const baseUrl = this.getCoinGeckoBaseUrl();
      const headers = this.getCoinGeckoHeaders();

      const response = await safeFetch(`${baseUrl}/search/trending`, { headers });
      if (!response) {
        return [];
      }

      const data = await response.json();
      return (data.coins || []).map((c: any) => c.item?.name || c.name).slice(0, 10);
    } catch (error) {
      logger.error({ error }, '[DataSources] CoinGecko trending failed');
      return [];
    }
  }

  // ============= DeFiLlama Integration =============

  async getDeFiTVL(): Promise<{ protocol: string; tvl: number; change24h: number }[]> {
    try {
      const response = await safeFetch('https://api.llama.fi/protocols');
      if (!response) {
        return [];
      }

      const data = await response.json();
      return (data || [])
        .slice(0, 20)
        .map((protocol: any) => ({
          protocol: protocol.name,
          tvl: protocol.tvl,
          change24h: protocol.change_1d || 0,
        }));
    } catch (error) {
      logger.error({ error }, '[DataSources] DeFiLlama fetch failed');
      return [];
    }
  }

  async getStablecoinFlows(): Promise<{ name: string; mcap: number; change7d: number }[]> {
    try {
      const response = await safeFetch('https://stablecoins.llama.fi/stablecoins?includePrices=true');
      if (!response) {
        return [];
      }

      const data = await response.json();
      return (data.peggedAssets || [])
        .slice(0, 10)
        .map((stable: any) => ({
          name: stable.name,
          mcap: stable.circulating?.peggedUSD || 0,
          change7d: stable.circulatingPrevWeek?.peggedUSD
            ? ((stable.circulating?.peggedUSD - stable.circulatingPrevWeek?.peggedUSD) /
                stable.circulatingPrevWeek?.peggedUSD) *
              100
            : 0,
        }));
    } catch (error) {
      logger.error({ error }, '[DataSources] DeFiLlama stablecoins failed');
      return [];
    }
  }

  // ============= SportMonks Integration =============

  async getUpcomingSportsEvents(sport: string = 'football'): Promise<SportEvent[]> {
    if (!this.sportMonksKey) {
      return [];
    }

    try {
      // SportMonks uses different endpoints per sport
      const endpoint =
        sport === 'football'
          ? 'https://api.sportmonks.com/v3/football/fixtures'
          : `https://api.sportmonks.com/v3/${sport}/fixtures`;

      const response = await safeFetch(`${endpoint}?api_token=${this.sportMonksKey}&include=odds`);
      if (!response) {
        return [];
      }

      const data = await response.json();
      return (data.data || []).slice(0, 20).map((event: any) => ({
        id: event.id?.toString(),
        sport,
        league: event.league?.name || 'Unknown',
        homeTeam: event.participants?.[0]?.name || 'Home',
        awayTeam: event.participants?.[1]?.name || 'Away',
        startTime: new Date(event.starting_at),
        status: this.mapSportMonksStatus(event.state?.state),
        odds: this.extractOdds(event.odds),
        score: event.scores
          ? {
              home: event.scores.localteam_score,
              away: event.scores.visitorteam_score,
            }
          : undefined,
      }));
    } catch (error) {
      logger.error({ error }, '[DataSources] SportMonks fetch failed');
      return [];
    }
  }

  private mapSportMonksStatus(state: string): 'upcoming' | 'live' | 'finished' {
    if (!state) return 'upcoming';
    if (['NS', 'TBA', 'POSTP'].includes(state)) return 'upcoming';
    if (['LIVE', '1H', '2H', 'HT', 'ET', 'PEN'].includes(state)) return 'live';
    return 'finished';
  }

  private extractOdds(odds: any[]): { home: number; away: number; draw?: number } | undefined {
    if (!odds || !odds.length) return undefined;
    const matchOdds = odds.find((o: any) => o.name === 'Match Winner' || o.market_id === 1);
    if (!matchOdds?.values) return undefined;

    return {
      home: parseFloat(matchOdds.values.find((v: any) => v.label === 'Home')?.value) || 0,
      away: parseFloat(matchOdds.values.find((v: any) => v.label === 'Away')?.value) || 0,
      draw: parseFloat(matchOdds.values.find((v: any) => v.label === 'Draw')?.value) || undefined,
    };
  }

  // ============= News Scraping (via RSS/API) =============

  async getNewsByCategory(
    category: keyof typeof NEWS_SOURCES
  ): Promise<NewsItem[]> {
    const cacheKey = `news-${category}`;
    const cached = this.newsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const allNews: NewsItem[] = [];

    // Use Google News RSS as aggregator for each source
    const sources = NEWS_SOURCES[category] || [];
    const sampleSources = sources.slice(0, 5); // Limit to avoid rate limits

    for (const source of sampleSources) {
      try {
        const rssUrl = `https://news.google.com/rss/search?q=site:${source}&hl=en-US&gl=US&ceid=US:en`;
        const response = await safeFetch(rssUrl, {}, 8000); // 8s timeout for RSS
        if (!response) {
          continue;
        }

        const text = await response.text();
        // Simple RSS parsing
        const items = this.parseRSS(text, source, category);
        allNews.push(...items);
      } catch (error) {
        logger.debug({ error, source }, '[DataSources] RSS fetch failed');
      }
    }

    // Sort by date and dedupe
    const sorted = allNews
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, 50);

    this.newsCache.set(cacheKey, { data: sorted, timestamp: Date.now() });
    return sorted;
  }

  private parseRSS(xml: string, source: string, category: string): NewsItem[] {
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      const title = this.extractTag(itemXml, 'title');
      const link = this.extractTag(itemXml, 'link');
      const pubDate = this.extractTag(itemXml, 'pubDate');
      const description = this.extractTag(itemXml, 'description');

      if (title && link) {
        items.push({
          id: crypto.randomUUID(),
          title: this.decodeHtml(title),
          summary: this.decodeHtml(description || title).slice(0, 300),
          url: link,
          source,
          publishedAt: pubDate ? new Date(pubDate) : new Date(),
          categories: [category],
          sentiment: 'neutral',
        });
      }
    }

    return items;
  }

  private extractTag(xml: string, tag: string): string {
    const regex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
    const match = xml.match(regex);
    return match ? (match[1] || match[2] || '').trim() : '';
  }

  private decodeHtml(html: string): string {
    return html
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]*>/g, '');
  }

  // ============= Aggregated Intelligence =============

  async getAllNews(): Promise<NewsItem[]> {
    const [crypto, politics, economy, geopolitics, sports] = await Promise.all([
      this.getCryptoNews('hot'),
      this.getNewsByCategory('politics'),
      this.getNewsByCategory('economy'),
      this.getNewsByCategory('geopolitics'),
      this.getNewsByCategory('sports'),
    ]);

    return [...crypto, ...politics, ...economy, ...geopolitics, ...sports]
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, 100);
  }

  async getMarketSignals(): Promise<MarketSignal[]> {
    const signals: MarketSignal[] = [];

    // Tavily web search signals for trending topics
    const tavilySignals = await this.getTavilyMarketSignals();
    signals.push(...tavilySignals);

    // Crypto signals
    const cryptoNews = await this.getCryptoNews('hot');
    for (const news of cryptoNews.slice(0, 10)) {
      signals.push({
        source: 'CryptoPanic',
        type: 'news',
        strength: news.relevanceScore || 50,
        direction: news.sentiment === 'positive' ? 'bullish' : news.sentiment === 'negative' ? 'bearish' : 'neutral',
        summary: news.title,
        relatedMarkets: this.inferRelatedMarkets(news.title, 'crypto'),
        timestamp: news.publishedAt,
        rawData: news,
      });
    }

    // Price signals
    const prices = await this.getCryptoPrices(['bitcoin', 'ethereum', 'solana']);
    for (const price of prices) {
      if (Math.abs(price.change24h) > 5) {
        signals.push({
          source: 'CoinGecko',
          type: 'price',
          strength: Math.min(100, Math.abs(price.change24h) * 5),
          direction: price.change24h > 0 ? 'bullish' : 'bearish',
          summary: `${price.name} ${price.change24h > 0 ? 'up' : 'down'} ${Math.abs(price.change24h).toFixed(1)}% in 24h`,
          relatedMarkets: this.inferRelatedMarkets(price.name, 'crypto'),
          timestamp: new Date(),
          rawData: price,
        });
      }
    }

    // Politics signals
    const politicsNews = await this.getNewsByCategory('politics');
    for (const news of politicsNews.slice(0, 5)) {
      signals.push({
        source: news.source,
        type: 'politics',
        strength: 60,
        direction: 'neutral',
        summary: news.title,
        relatedMarkets: this.inferRelatedMarkets(news.title, 'politics'),
        timestamp: news.publishedAt,
        rawData: news,
      });
    }

    // Sports signals
    const sportsEvents = await this.getUpcomingSportsEvents('football');
    for (const event of sportsEvents.filter((e) => e.status === 'upcoming').slice(0, 5)) {
      signals.push({
        source: 'SportMonks',
        type: 'sports',
        strength: 50,
        direction: 'neutral',
        summary: `${event.homeTeam} vs ${event.awayTeam} (${event.league})`,
        relatedMarkets: [`${event.homeTeam}`, `${event.awayTeam}`, event.league],
        timestamp: event.startTime,
        rawData: event,
      });
    }

    // Store in buffer
    this.signalBuffer = [...signals, ...this.signalBuffer].slice(0, this.MAX_SIGNALS);

    return signals;
  }

  /**
   * Get market signals from Tavily web search
   * Searches for breaking news on trending prediction market topics
   */
  private async getTavilyMarketSignals(): Promise<MarketSignal[]> {
    if (!this.tavilyApiKey) {
      return [];
    }

    const signals: MarketSignal[] = [];

    // Key topics to search for prediction market relevance
    const trendingQueries = [
      { query: 'Bitcoin price prediction latest news', category: 'crypto' },
      { query: 'US election 2024 latest polls', category: 'politics' },
      { query: 'Federal Reserve interest rate decision', category: 'economy' },
      { query: 'breaking news prediction markets', category: 'general' },
    ];

    // Run searches in parallel for efficiency
    const searchPromises = trendingQueries.map(async ({ query, category }) => {
      try {
        const context = await this.getMarketContext(query, category as any);
        if (context && context.sources.length > 0) {
          return {
            source: 'Tavily',
            type: 'web' as const,
            strength: context.confidence,
            direction: context.sentiment,
            summary: context.summary.slice(0, 300),
            relatedMarkets: this.inferRelatedMarkets(context.summary, category),
            timestamp: new Date(),
            rawData: {
              query,
              category,
              sources: context.sources.slice(0, 3).map(s => ({ title: s.title, url: s.url })),
            },
          };
        }
        return null;
      } catch (error) {
        logger.debug({ error, query }, '[DataSources] Tavily search failed for query');
        return null;
      }
    });

    const results = await Promise.all(searchPromises);
    for (const result of results) {
      if (result) {
        signals.push(result);
      }
    }

    logger.debug({ count: signals.length }, '[DataSources] Tavily signals generated');
    return signals;
  }

  private inferRelatedMarkets(text: string, category: string): string[] {
    const markets: string[] = [];
    const lowerText = text.toLowerCase();

    // Crypto keywords
    if (category === 'crypto') {
      if (lowerText.includes('bitcoin') || lowerText.includes('btc')) markets.push('Bitcoin');
      if (lowerText.includes('ethereum') || lowerText.includes('eth')) markets.push('Ethereum');
      if (lowerText.includes('solana') || lowerText.includes('sol')) markets.push('Solana');
      if (lowerText.includes('etf')) markets.push('Bitcoin ETF', 'Ethereum ETF');
    }

    // Politics keywords
    if (category === 'politics') {
      if (lowerText.includes('trump')) markets.push('Trump', 'Republican');
      if (lowerText.includes('biden')) markets.push('Biden', 'Democrat');
      if (lowerText.includes('harris')) markets.push('Harris', 'Democrat');
      if (lowerText.includes('election')) markets.push('Election', 'President');
      if (lowerText.includes('fed') || lowerText.includes('interest rate')) markets.push('Fed', 'Interest Rate');
    }

    return [...new Set(markets)];
  }

  // ============= Public Getters =============

  getRecentSignals(minutes: number = 30): MarketSignal[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.signalBuffer.filter((s) => s.timestamp.getTime() > cutoff);
  }

  getSignalsByType(type: MarketSignal['type']): MarketSignal[] {
    return this.signalBuffer.filter((s) => s.type === type);
  }

  getNewsSources(): typeof NEWS_SOURCES {
    return NEWS_SOURCES;
  }

  getTwitterAccounts(): typeof TWITTER_ACCOUNTS {
    return TWITTER_ACCOUNTS;
  }
}
