/**
 * Data Sources Service
 *
 * Aggregates multiple data APIs for market intelligence:
 * - CryptoPanic (crypto news)
 * - CoinGecko (crypto prices)
 * - DeFiLlama (DeFi data)
 * - SportMonks (sports data)
 * - Twitter (social signals)
 * - News scraping (politics, economy, geopolitics)
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';

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
  type: 'news' | 'social' | 'price' | 'sports' | 'politics';
  strength: number; // 0-100
  direction: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  relatedMarkets: string[];
  timestamp: Date;
  rawData: unknown;
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

  private cryptoPanicKey: string;
  private coinGeckoKey: string;
  private defiLlamaKey: string;
  private sportMonksKey: string;
  private twitterClientId: string;
  private twitterClientSecret: string;

  private newsCache: Map<string, { data: NewsItem[]; timestamp: number }> = new Map();
  private priceCache: Map<string, { data: CryptoPrice; timestamp: number }> = new Map();
  private signalBuffer: MarketSignal[] = [];

  private readonly CACHE_TTL = 60000; // 1 minute
  private readonly MAX_SIGNALS = 1000;

  constructor() {
    super();
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
    this.cryptoPanicKey = this.cryptoPanicKey || runtime.getSetting('CRYPTOPANIC_API_KEY') || '';
    this.coinGeckoKey = this.coinGeckoKey || runtime.getSetting('COINGECKO_API_KEY') || '';
    this.defiLlamaKey = this.defiLlamaKey || runtime.getSetting('DEFILLAMA_API_KEY') || '';
    this.sportMonksKey = this.sportMonksKey || runtime.getSetting('SPORTMONKS_API_KEY') || '';

    logger.info('[DataSources] Available data sources:', {
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
    this.signalBuffer = [];
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

      const params = new URLSearchParams({
        auth_token: this.cryptoPanicKey,
        public: 'true',
      });
      if (filter) params.append('filter', filter);

      const response = await fetch(`https://cryptopanic.com/api/v1/posts/?${params}`);

      // Check if response is OK before parsing
      if (!response.ok) {
        logger.warn({ status: response.status }, '[DataSources] CryptoPanic API error');
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

      const response = await fetch(url, { headers });
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

      const response = await fetch(`${baseUrl}/search/trending`, { headers });
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
      const response = await fetch('https://api.llama.fi/protocols');
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
      const response = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true');
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

      const response = await fetch(`${endpoint}?api_token=${this.sportMonksKey}&include=odds`);
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
        const response = await fetch(rssUrl);
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
