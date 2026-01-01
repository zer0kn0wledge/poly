/**
 * Twitter Monitor Service
 *
 * Real-time monitoring of key Twitter accounts and keywords
 * for trading signals. Uses Twitter API v2.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';

export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorFollowers: number;
  createdAt: Date;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  metrics: {
    engagement: number;
    viralScore: number;
  };
}

export interface TwitterAlert {
  tweet: Tweet;
  alertType: 'breaking' | 'sentiment' | 'whale' | 'keyword';
  relevance: number;
  matchedKeywords: string[];
  inferredMarkets: string[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

// Keywords to monitor for each category
const MONITOR_KEYWORDS = {
  crypto: [
    'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'defi', 'nft',
    'binance', 'coinbase', 'sec crypto', 'bitcoin etf', 'eth etf',
    'bull run', 'bear market', 'ath', 'pump', 'dump', 'moon'
  ],
  politics: [
    'breaking:', 'just in:', 'trump', 'biden', 'harris', 'desantis',
    'election', 'poll', 'vote', 'supreme court', 'congress', 'senate',
    'white house', 'indictment', 'impeach', 'debate'
  ],
  economics: [
    'fed', 'fomc', 'interest rate', 'inflation', 'cpi', 'gdp',
    'unemployment', 'jobs report', 'recession', 'powell', 'treasury',
    'yield', 'bond', 'dollar', 'forex'
  ],
  sports: [
    'injury report', 'out for', 'questionable', 'trade', 'signed',
    'breaking:', 'just in:', 'starting lineup', 'suspended'
  ],
  general: [
    'breaking news', 'just in', 'developing:', 'confirmed:',
    'exclusive:', 'urgent:', 'alert:'
  ]
};

// High-influence accounts by category (10+ per vertical)
const WATCH_ACCOUNTS = {
  // Crypto influencers & analysts
  crypto: [
    'VitalikButerin', 'saylor', 'CryptoHayes', 'caborkie0x',
    'inversebrah', 'DegenSpartan', 'trader_XO', 'GCRClassic',
    'CryptoCobain', 'loomdart', 'lightcrypto', 'Pentosh1',
    'CroissantEth', 'DefiIgnas', 'Route2FI', 'milaborkDotEth'
  ],
  // Breaking news aggregators
  news: [
    'DeItaone', 'Fxhedgers', 'unusual_whales', 'disclosetv',
    'BNONews', 'spectaborindex', 'FirstSquawk', 'LiveSquawk',
    'NewsLambert', 'FastMoneyCNBC', 'BreakingNews', 'AP',
    'Reuters', 'AFP', 'BBCBreaking', 'CNNBreaking'
  ],
  // Politics & elections
  politics: [
    'Politico', 'thehill', 'axios', 'Nate_Cohn',
    'redistrict', 'NateSilver538', 'DecisionDeskHQ', 'CookPolitical',
    'RealClearNews', 'FiveThirtyEight', 'PollTrackerUSA', 'SteveKornacki',
    'ElectionWiz', 'Politics_Polls', 'USPoliticsPoll', 'ElectoralPolls'
  ],
  // Sports insiders (NBA, NFL, MLB, Soccer)
  sports: [
    'wojespn', 'ShamsCharania', 'AdamSchefter', 'RapSheet',
    'JeffPassan', 'FabrizioRomano', 'MarcJSpears', 'ChrisBHaynes',
    'FieldYates', 'JayGlazer', 'MikeGarafolo', 'JonathanJones',
    'Ken_Rosenthal', 'JonMorosi', 'wojespnNBA', 'WindhorstESPN'
  ],
  // Markets & finance
  markets: [
    'zerohedge', 'WSJ', 'Bloomberg', 'Reuters',
    'CNBC', 'FinancialTimes', 'Markets', 'Schuldensuehner',
    'NorthmanTrader', 'PeterSchiff', 'jimcramer', 'Carl_C_Icahn',
    'elerianm', 'markets', 'GoldmanSachs', 'jpmorgan'
  ],
  // Geopolitics & world news
  geopolitics: [
    'AFP', 'AJEnglish', 'BBCWorld', 'dabornews',
    'RT_com', 'cgaborews', 'ABOROAE', 'SCMPNews',
    'France24_en', 'euaborews', 'MiddleEastEye', 'Jerusalem_Post',
    'KyivIndependent', 'nexaborews', 'guardian', 'naborimes'
  ],
  // Tech & AI
  tech: [
    'elonmusk', 'sataborella', 'OpenAI', 'AnthropicAI',
    'TechCrunch', 'verge', 'WIRED', 'engadget',
    'aaborechnica', 'ZDNet', 'VentureBeat', 'mashable'
  ],
  // Polymarket & prediction markets
  prediction_markets: [
    'Polymarket', 'KaaborGroup', 'Metaculus', 'manabormarkets',
    'PredictIt', 'PolymarketPicks', 'PMSignals', 'PolymarketNews',
    'AugurProject', 'GnosisDAO', 'polymarket_bot', 'PM_Whale_Alert'
  ]
};

export class TwitterMonitorService extends Service {
  static override readonly serviceType = 'twitter-monitor';
  override capabilityDescription = 'Monitors Twitter for prediction market signals';

  private bearerToken: string = '';
  private clientId: string = '';
  private clientSecret: string = '';
  private accessToken: string = '';
  private accessTokenSecret: string = '';

  private alertBuffer: TwitterAlert[] = [];
  private lastSearchTime: Map<string, number> = new Map();
  private readonly MAX_ALERTS = 500;
  private readonly SEARCH_COOLDOWN = 15000; // 15 seconds between searches

  constructor() {
    super();
  }


  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[TwitterMonitor] Initializing Twitter monitor service');

    // Load credentials
    this.clientId = process.env.TWITTER_CLIENT_ID || runtime.getSetting('TWITTER_CLIENT_ID') || '';
    this.clientSecret = process.env.TWITTER_CLIENT_SECRET || runtime.getSetting('TWITTER_CLIENT_SECRET') || '';
    this.accessToken = process.env.TWITTER_ACCESS_TOKEN || runtime.getSetting('TWITTER_ACCESS_TOKEN') || '';
    this.accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET || runtime.getSetting('TWITTER_ACCESS_TOKEN_SECRET') || '';

    // For app-only auth (higher rate limits)
    this.bearerToken = process.env.TWITTER_BEARER_TOKEN || runtime.getSetting('TWITTER_BEARER_TOKEN') || '';

    // If no bearer token, we could generate one from client credentials
    if (!this.bearerToken && this.clientId && this.clientSecret) {
      await this.generateBearerToken();
    }

    logger.info('[TwitterMonitor] Twitter credentials loaded:', {
      hasBearerToken: !!this.bearerToken,
      hasClientCredentials: !!(this.clientId && this.clientSecret),
      hasUserCredentials: !!(this.accessToken && this.accessTokenSecret),
    });
  }

  private async generateBearerToken(): Promise<void> {
    try {
      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const response = await fetch('https://api.twitter.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });

      const data = await response.json();
      if (data.access_token) {
        this.bearerToken = data.access_token;
        logger.info('[TwitterMonitor] Bearer token generated successfully');
      }
    } catch (error) {
      logger.error({ error }, '[TwitterMonitor] Failed to generate bearer token');
    }
  }

  override async stop(): Promise<void> {
    logger.info('[TwitterMonitor] Stopping Twitter monitor service');
    this.alertBuffer = [];
    this.lastSearchTime.clear();
  }

  // ============= Search Methods =============

  async searchTweets(query: string, maxResults: number = 10): Promise<Tweet[]> {
    if (!this.bearerToken) {
      logger.warn('[TwitterMonitor] No bearer token available');
      return [];
    }

    // Rate limit check
    const lastSearch = this.lastSearchTime.get(query) || 0;
    if (Date.now() - lastSearch < this.SEARCH_COOLDOWN) {
      logger.debug('[TwitterMonitor] Search cooldown active for query:', query);
      return [];
    }

    try {
      const params = new URLSearchParams({
        query: `${query} -is:retweet lang:en`,
        max_results: Math.min(maxResults, 100).toString(),
        'tweet.fields': 'created_at,public_metrics,author_id',
        'user.fields': 'username,name,public_metrics',
        expansions: 'author_id',
      });

      const response = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?${params}`,
        {
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        logger.error({ status: response.status, error }, '[TwitterMonitor] Search failed');
        return [];
      }

      const data = await response.json();
      this.lastSearchTime.set(query, Date.now());

      // Map users for lookup
      const users = new Map<string, any>();
      for (const user of data.includes?.users || []) {
        users.set(user.id, user);
      }

      return (data.data || []).map((tweet: any) => {
        const author = users.get(tweet.author_id) || {};
        return this.mapTweet(tweet, author);
      });
    } catch (error) {
      logger.error({ error }, '[TwitterMonitor] Tweet search failed');
      return [];
    }
  }

  async getUserTweets(username: string, maxResults: number = 10): Promise<Tweet[]> {
    if (!this.bearerToken) {
      return [];
    }

    try {
      // First get user ID
      const userResponse = await fetch(
        `https://api.twitter.com/2/users/by/username/${username}?user.fields=public_metrics`,
        {
          headers: { Authorization: `Bearer ${this.bearerToken}` },
        }
      );

      const userData = await userResponse.json();
      if (!userData.data?.id) {
        return [];
      }

      const userId = userData.data.id;
      const userInfo = userData.data;

      // Get tweets
      const params = new URLSearchParams({
        max_results: Math.min(maxResults, 100).toString(),
        'tweet.fields': 'created_at,public_metrics',
        exclude: 'retweets,replies',
      });

      const tweetsResponse = await fetch(
        `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
        {
          headers: { Authorization: `Bearer ${this.bearerToken}` },
        }
      );

      const tweetsData = await tweetsResponse.json();

      return (tweetsData.data || []).map((tweet: any) =>
        this.mapTweet(tweet, userInfo)
      );
    } catch (error) {
      logger.error({ error, username }, '[TwitterMonitor] Get user tweets failed');
      return [];
    }
  }

  private mapTweet(tweet: any, author: any): Tweet {
    const metrics = tweet.public_metrics || {};
    const authorMetrics = author.public_metrics || {};

    const engagement =
      (metrics.like_count || 0) +
      (metrics.retweet_count || 0) * 2 +
      (metrics.reply_count || 0) +
      (metrics.quote_count || 0) * 1.5;

    const viralScore = authorMetrics.followers_count
      ? (engagement / authorMetrics.followers_count) * 1000
      : 0;

    return {
      id: tweet.id,
      text: tweet.text,
      authorId: tweet.author_id || author.id,
      authorUsername: author.username || 'unknown',
      authorName: author.name || 'Unknown',
      authorFollowers: authorMetrics.followers_count || 0,
      createdAt: new Date(tweet.created_at),
      likeCount: metrics.like_count || 0,
      retweetCount: metrics.retweet_count || 0,
      replyCount: metrics.reply_count || 0,
      quoteCount: metrics.quote_count || 0,
      metrics: {
        engagement,
        viralScore,
      },
    };
  }

  // ============= Alert Generation =============

  async scanForAlerts(categories: string[] = ['crypto', 'politics', 'sports']): Promise<TwitterAlert[]> {
    const alerts: TwitterAlert[] = [];

    for (const category of categories) {
      const keywords = MONITOR_KEYWORDS[category as keyof typeof MONITOR_KEYWORDS] || [];
      const accounts = WATCH_ACCOUNTS[category as keyof typeof WATCH_ACCOUNTS] || [];

      // Search by keywords (sample a few)
      const keywordSample = keywords.slice(0, 3);
      for (const keyword of keywordSample) {
        const tweets = await this.searchTweets(keyword, 5);

        for (const tweet of tweets) {
          const alert = this.evaluateTweet(tweet, category, [keyword]);
          if (alert && alert.relevance >= 50) {
            alerts.push(alert);
          }
        }

        // Small delay to avoid rate limits
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Check watched accounts (sample a few)
      const accountSample = accounts.slice(0, 3);
      for (const account of accountSample) {
        const tweets = await this.getUserTweets(account, 3);

        for (const tweet of tweets) {
          // Recent tweets only (last 30 min)
          if (Date.now() - tweet.createdAt.getTime() > 30 * 60 * 1000) continue;

          const alert = this.evaluateTweet(tweet, category, []);
          if (alert) {
            alert.alertType = 'breaking';
            alert.relevance = Math.min(100, alert.relevance + 20); // Boost for watched accounts
            alerts.push(alert);
          }
        }

        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Add to buffer
    this.alertBuffer = [...alerts, ...this.alertBuffer].slice(0, this.MAX_ALERTS);

    return alerts;
  }

  private evaluateTweet(tweet: Tweet, category: string, matchedKeywords: string[]): TwitterAlert | null {
    const text = tweet.text.toLowerCase();

    // Find all matched keywords
    const allKeywords = MONITOR_KEYWORDS[category as keyof typeof MONITOR_KEYWORDS] || [];
    const matched = allKeywords.filter((kw) => text.includes(kw.toLowerCase()));

    // Calculate relevance
    let relevance = 30; // Base

    // Engagement boost
    if (tweet.metrics.engagement > 1000) relevance += 20;
    if (tweet.metrics.engagement > 10000) relevance += 20;

    // Follower boost
    if (tweet.authorFollowers > 100000) relevance += 15;
    if (tweet.authorFollowers > 1000000) relevance += 15;

    // Keyword match boost
    relevance += matched.length * 5;

    // Breaking news boost
    if (text.includes('breaking') || text.includes('just in')) relevance += 15;

    // Determine sentiment
    const sentiment = this.analyzeSentiment(text);

    // Infer related markets
    const markets = this.inferMarkets(text, category);

    if (relevance < 30 || markets.length === 0) {
      return null;
    }

    return {
      tweet,
      alertType: matched.length > 2 ? 'keyword' : 'sentiment',
      relevance: Math.min(100, relevance),
      matchedKeywords: [...matchedKeywords, ...matched],
      inferredMarkets: markets,
      sentiment,
    };
  }

  private analyzeSentiment(text: string): 'bullish' | 'bearish' | 'neutral' {
    const bullishWords = ['moon', 'pump', 'bullish', 'ath', 'breakout', 'rally', 'surge', 'soar', 'win', 'victory', 'ahead', 'lead'];
    const bearishWords = ['dump', 'crash', 'bearish', 'plunge', 'collapse', 'fail', 'loss', 'behind', 'trail', 'down'];

    const lowerText = text.toLowerCase();
    let bullishScore = 0;
    let bearishScore = 0;

    for (const word of bullishWords) {
      if (lowerText.includes(word)) bullishScore++;
    }
    for (const word of bearishWords) {
      if (lowerText.includes(word)) bearishScore++;
    }

    if (bullishScore > bearishScore + 1) return 'bullish';
    if (bearishScore > bullishScore + 1) return 'bearish';
    return 'neutral';
  }

  private inferMarkets(text: string, category: string): string[] {
    const markets: string[] = [];
    const lowerText = text.toLowerCase();

    // Crypto
    if (lowerText.includes('bitcoin') || lowerText.includes('btc')) markets.push('Bitcoin');
    if (lowerText.includes('ethereum') || lowerText.includes('eth')) markets.push('Ethereum');
    if (lowerText.includes('solana') || lowerText.includes('sol')) markets.push('Solana');
    if (lowerText.includes('etf')) markets.push('Bitcoin ETF');

    // Politics
    if (lowerText.includes('trump')) markets.push('Trump', 'Republican');
    if (lowerText.includes('biden')) markets.push('Biden', 'Democrat');
    if (lowerText.includes('harris')) markets.push('Harris');
    if (lowerText.includes('election') || lowerText.includes('vote')) markets.push('Election');

    // Economics
    if (lowerText.includes('fed') || lowerText.includes('fomc')) markets.push('Fed', 'Interest Rate');
    if (lowerText.includes('inflation') || lowerText.includes('cpi')) markets.push('Inflation');

    // Sports (generic)
    if (category === 'sports') {
      // Extract team names (simplified)
      const teams = text.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) || [];
      markets.push(...teams.slice(0, 3));
    }

    return [...new Set(markets)];
  }

  // ============= Public Getters =============

  getRecentAlerts(minutes: number = 30): TwitterAlert[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.alertBuffer.filter((a) => a.tweet.createdAt.getTime() > cutoff);
  }

  getAlertsByCategory(category: string): TwitterAlert[] {
    const keywords = MONITOR_KEYWORDS[category as keyof typeof MONITOR_KEYWORDS] || [];
    return this.alertBuffer.filter((a) =>
      a.matchedKeywords.some((kw) => keywords.includes(kw))
    );
  }

  getHighRelevanceAlerts(minRelevance: number = 70): TwitterAlert[] {
    return this.alertBuffer.filter((a) => a.relevance >= minRelevance);
  }

  getMonitorKeywords(): typeof MONITOR_KEYWORDS {
    return MONITOR_KEYWORDS;
  }

  getWatchAccounts(): typeof WATCH_ACCOUNTS {
    return WATCH_ACCOUNTS;
  }
}
