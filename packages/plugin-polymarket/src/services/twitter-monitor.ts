/**
 * Twitter Monitor Service
 *
 * Real-time monitoring of key Twitter accounts and keywords
 * for trading signals. Uses Twitter API v2.
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
      logger.warn({ url: url.split('?')[0] }, '[TwitterMonitor] Request timed out');
    } else {
      logger.debug({ error, url: url.split('?')[0] }, '[TwitterMonitor] Fetch failed');
    }
    return null;
  }
}

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
  alertType: 'breaking' | 'sentiment' | 'whale' | 'keyword' | 'mention';
  relevance: number;
  matchedKeywords: string[];
  inferredMarkets: string[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  createdAt: Date;
  conversationId?: string;
  inReplyToUserId?: string;
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

  static async start(runtime: IAgentRuntime): Promise<TwitterMonitorService> {
    const service = new TwitterMonitorService();
    await service.initialize(runtime);
    return service;
  }

  private bearerToken: string = '';
  private clientId: string = '';
  private clientSecret: string = '';
  private accessToken: string = '';
  private accessTokenSecret: string = '';

  private alertBuffer: TwitterAlert[] = [];
  private mentionBuffer: Mention[] = [];
  private lastSearchTime: Map<string, number> = new Map();
  private lastGlobalRequest: number = 0;
  private lastMentionId: string = '';
  private ownUserId: string = '';
  private ownUsername: string = '';
  private readonly MAX_ALERTS = 500;
  private readonly MAX_MENTIONS = 100;
  private readonly SEARCH_COOLDOWN = 60000; // 60 seconds between same searches
  private readonly GLOBAL_REQUEST_DELAY = 5000; // 5 seconds between ANY request
  private readonly MAX_REQUESTS_PER_CYCLE = 5; // Max requests per scan cycle
  private mentionPollInterval: NodeJS.Timer | null = null;

  // Rate limiting state
  private rateLimitedUntil: Date | null = null;
  private monthlyCapExceeded: boolean = false;
  private readonly RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
  private runtime: IAgentRuntime | null = null;

  constructor() {
    super();
  }

  /**
   * Check if we're currently rate limited
   */
  private isRateLimited(): boolean {
    if (this.monthlyCapExceeded) {
      return true;
    }
    if (this.rateLimitedUntil && new Date() < this.rateLimitedUntil) {
      return true;
    }
    return false;
  }

  /**
   * Handle Twitter API errors, especially 429s
   */
  private handleTwitterError(status: number, errorData: any): void {
    if (status === 429) {
      const errorTitle = errorData?.title || '';
      const errorDetail = errorData?.detail || '';

      // Check if it's monthly cap vs temporary rate limit
      if (errorTitle === 'UsageCapExceeded' || errorDetail.includes('Monthly')) {
        logger.error('[TwitterMonitor] MONTHLY CAP EXCEEDED - Disabling Twitter monitoring');
        this.monthlyCapExceeded = true;

        // Store this so it persists across restarts
        if (this.runtime) {
          this.runtime.setSetting('TWITTER_MONTHLY_CAP_EXCEEDED', 'true');
          this.runtime.setSetting('TWITTER_CAP_EXCEEDED_DATE', new Date().toISOString());
        }
      } else {
        // Temporary rate limit - back off
        this.rateLimitedUntil = new Date(Date.now() + this.RATE_LIMIT_BACKOFF_MS);
        logger.warn({ resumeAt: this.rateLimitedUntil.toISOString() },
          '[TwitterMonitor] Rate limited, backing off for 15 minutes');
      }
    }
  }

  /**
   * Check rate limit status from previous sessions
   */
  private checkRateLimitStatus(): void {
    if (!this.runtime) return;

    const capExceeded = this.runtime.getSetting('TWITTER_MONTHLY_CAP_EXCEEDED');
    const capDate = this.runtime.getSetting('TWITTER_CAP_EXCEEDED_DATE');

    if (capExceeded === 'true' && capDate) {
      const exceedDate = new Date(capDate);
      const now = new Date();

      // Reset if we're in a new month
      if (exceedDate.getMonth() !== now.getMonth() ||
          exceedDate.getFullYear() !== now.getFullYear()) {
        logger.info('[TwitterMonitor] New month - resetting cap exceeded flag');
        this.runtime.setSetting('TWITTER_MONTHLY_CAP_EXCEEDED', 'false');
        this.monthlyCapExceeded = false;
      } else {
        logger.warn('[TwitterMonitor] Monthly cap still exceeded from previous session');
        this.monthlyCapExceeded = true;
      }
    }
  }


  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[TwitterMonitor] Initializing Twitter monitor service');
    this.runtime = runtime;

    // Check rate limit status from previous sessions
    this.checkRateLimitStatus();

    // If monthly cap exceeded, skip initialization
    if (this.monthlyCapExceeded) {
      logger.warn('[TwitterMonitor] Monthly cap exceeded - skipping Twitter API initialization');
      return;
    }

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

    // Get our own user info for mention monitoring
    if (this.bearerToken) {
      await this.fetchOwnUserInfo(runtime);
    }

    // Start mention polling if we have the required credentials
    // Use longer poll interval (5 minutes) to conserve rate limits
    if (this.ownUserId && this.bearerToken) {
      this.startMentionPolling();
    }
  }

  /**
   * Fetch our own Twitter user info for mention monitoring
   */
  private async fetchOwnUserInfo(runtime: IAgentRuntime): Promise<void> {
    try {
      // Try to get username from config
      this.ownUsername = runtime.getSetting('TWITTER_USERNAME') ||
                         process.env.TWITTER_USERNAME || '';

      if (!this.ownUsername) {
        logger.warn('[TwitterMonitor] TWITTER_USERNAME not set - mention monitoring disabled');
        return;
      }

      // Clean up username (remove @ if present)
      this.ownUsername = this.ownUsername.replace(/^@/, '');

      await this.enforceRateLimit();

      const response = await safeFetch(
        `https://api.twitter.com/2/users/by/username/${this.ownUsername}`,
        {
          headers: { Authorization: `Bearer ${this.bearerToken}` },
        }
      );

      if (!response || !response.ok) {
        logger.warn('[TwitterMonitor] Could not fetch own user info');
        return;
      }

      const data = await response.json();
      if (data.data?.id) {
        this.ownUserId = data.data.id;
        logger.info({ userId: this.ownUserId, username: this.ownUsername },
          '[TwitterMonitor] Own user info fetched for mention monitoring');
      }
    } catch (error) {
      logger.error({ error }, '[TwitterMonitor] Failed to fetch own user info');
    }
  }

  /**
   * Start polling for mentions
   */
  private startMentionPolling(): void {
    // Poll every 5 minutes to conserve rate limits (Twitter free tier is very limited)
    const POLL_INTERVAL = 5 * 60 * 1000;

    logger.info({ pollInterval: POLL_INTERVAL / 1000 + 's' },
      '[TwitterMonitor] Starting mention polling');

    this.mentionPollInterval = setInterval(async () => {
      // Skip if rate limited
      if (this.isRateLimited()) {
        logger.debug('[TwitterMonitor] Skipping poll - rate limited');
        return;
      }

      try {
        await this.pollMentions();
      } catch (error) {
        logger.error({ error }, '[TwitterMonitor] Mention poll failed');
      }
    }, POLL_INTERVAL);

    // Also do an initial poll (after a short delay to not hit rate limits immediately)
    setTimeout(() => {
      if (!this.isRateLimited()) {
        this.pollMentions().catch(err =>
          logger.error({ err }, '[TwitterMonitor] Initial mention poll failed')
        );
      }
    }, 10000); // 10 second delay
  }

  /**
   * Poll for new mentions
   */
  async pollMentions(): Promise<Mention[]> {
    if (!this.bearerToken || !this.ownUserId) {
      return [];
    }

    // Check rate limit before making request
    if (this.isRateLimited()) {
      logger.debug('[TwitterMonitor] Skipping pollMentions - rate limited');
      return [];
    }

    await this.enforceRateLimit();

    try {
      const params = new URLSearchParams({
        max_results: '10', // Reduced from 20 to conserve rate limits
        'tweet.fields': 'created_at,conversation_id,in_reply_to_user_id,author_id',
        'user.fields': 'username',
        expansions: 'author_id',
      });

      // Use since_id to only get new mentions
      if (this.lastMentionId) {
        params.set('since_id', this.lastMentionId);
      }

      const response = await safeFetch(
        `https://api.twitter.com/2/users/${this.ownUserId}/mentions?${params}`,
        {
          headers: { Authorization: `Bearer ${this.bearerToken}` },
        }
      );

      if (!response) {
        return [];
      }

      if (!response.ok) {
        // Parse error and handle rate limits
        let errorData: any = {};
        try {
          const errorText = await response.text();
          errorData = JSON.parse(errorText);
        } catch {
          // Ignore parse errors
        }

        // Handle rate limiting
        this.handleTwitterError(response.status, errorData);

        logger.warn({ status: response.status, error: errorData },
          '[TwitterMonitor] Mention fetch failed');
        return [];
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        return [];
      }

      // Map users for lookup
      const users = new Map<string, string>();
      for (const user of data.includes?.users || []) {
        users.set(user.id, user.username);
      }

      const newMentions: Mention[] = data.data.map((tweet: any) => ({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.author_id,
        authorUsername: users.get(tweet.author_id) || 'unknown',
        createdAt: new Date(tweet.created_at),
        conversationId: tweet.conversation_id,
        inReplyToUserId: tweet.in_reply_to_user_id,
      }));

      // Update last mention ID to the newest
      if (newMentions.length > 0) {
        this.lastMentionId = newMentions[0].id;

        // Add to buffer
        this.mentionBuffer = [...newMentions, ...this.mentionBuffer].slice(0, this.MAX_MENTIONS);

        logger.info({ count: newMentions.length }, '[TwitterMonitor] New mentions received');
      }

      return newMentions;
    } catch (error) {
      logger.error({ error }, '[TwitterMonitor] Poll mentions failed');
      return [];
    }
  }

  private async generateBearerToken(): Promise<void> {
    try {
      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const response = await safeFetch('https://api.twitter.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });

      if (!response) {
        logger.warn('[TwitterMonitor] Bearer token request failed');
        return;
      }

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

    // Stop mention polling
    if (this.mentionPollInterval) {
      clearInterval(this.mentionPollInterval);
      this.mentionPollInterval = null;
    }

    this.alertBuffer = [];
    this.mentionBuffer = [];
    this.lastSearchTime.clear();
  }

  // ============= Search Methods =============

  private async enforceRateLimit(): Promise<boolean> {
    const timeSinceLastRequest = Date.now() - this.lastGlobalRequest;
    if (timeSinceLastRequest < this.GLOBAL_REQUEST_DELAY) {
      const waitTime = this.GLOBAL_REQUEST_DELAY - timeSinceLastRequest;
      await new Promise(r => setTimeout(r, waitTime));
    }
    this.lastGlobalRequest = Date.now();
    return true;
  }

  async searchTweets(query: string, maxResults: number = 10): Promise<Tweet[]> {
    if (!this.bearerToken) {
      logger.warn('[TwitterMonitor] No bearer token available');
      return [];
    }

    // Per-query cooldown
    const lastSearch = this.lastSearchTime.get(query) || 0;
    if (Date.now() - lastSearch < this.SEARCH_COOLDOWN) {
      return []; // Silent return, already logged at debug level
    }

    // Global rate limit
    await this.enforceRateLimit();

    try {
      const params = new URLSearchParams({
        query: `${query} -is:retweet lang:en`,
        max_results: Math.max(10, Math.min(maxResults, 100)).toString(),
        'tweet.fields': 'created_at,public_metrics,author_id',
        'user.fields': 'username,name,public_metrics',
        expansions: 'author_id',
      });

      const response = await safeFetch(
        `https://api.twitter.com/2/tweets/search/recent?${params}`,
        {
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
          },
        }
      );

      if (!response) {
        return [];
      }

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

    // Global rate limit
    await this.enforceRateLimit();

    try {
      // First get user ID
      const userResponse = await safeFetch(
        `https://api.twitter.com/2/users/by/username/${username}?user.fields=public_metrics`,
        {
          headers: { Authorization: `Bearer ${this.bearerToken}` },
        }
      );

      if (!userResponse) {
        return [];
      }

      const userData = await userResponse.json();
      if (!userData.data?.id) {
        return [];
      }

      const userId = userData.data.id;
      const userInfo = userData.data;

      // Get tweets (Twitter API requires max_results between 10-100)
      const params = new URLSearchParams({
        max_results: Math.max(10, Math.min(maxResults, 100)).toString(),
        'tweet.fields': 'created_at,public_metrics',
        exclude: 'retweets,replies',
      });

      const tweetsResponse = await safeFetch(
        `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
        {
          headers: { Authorization: `Bearer ${this.bearerToken}` },
        }
      );

      if (!tweetsResponse) {
        return [];
      }

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
    let requestCount = 0;

    for (const category of categories) {
      // Stop if we've hit the request limit
      if (requestCount >= this.MAX_REQUESTS_PER_CYCLE) break;

      const keywords = MONITOR_KEYWORDS[category as keyof typeof MONITOR_KEYWORDS] || [];
      const accounts = WATCH_ACCOUNTS[category as keyof typeof WATCH_ACCOUNTS] || [];

      // Search by keywords (just 1 per category to reduce requests)
      const keywordSample = keywords.slice(0, 1);
      for (const keyword of keywordSample) {
        if (requestCount >= this.MAX_REQUESTS_PER_CYCLE) break;

        const tweets = await this.searchTweets(keyword, 5);
        requestCount++;

        for (const tweet of tweets) {
          const alert = this.evaluateTweet(tweet, category, [keyword]);
          if (alert && alert.relevance >= 50) {
            alerts.push(alert);
          }
        }
      }

      // Check watched accounts (just 1 per category)
      const accountSample = accounts.slice(0, 1);
      for (const account of accountSample) {
        if (requestCount >= this.MAX_REQUESTS_PER_CYCLE) break;

        const tweets = await this.getUserTweets(account, 3);
        requestCount++;

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

  // ============= Mention Getters =============

  /**
   * Get recent mentions
   */
  getRecentMentions(minutes: number = 30): Mention[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.mentionBuffer.filter((m) => m.createdAt.getTime() > cutoff);
  }

  /**
   * Get all buffered mentions
   */
  getAllMentions(): Mention[] {
    return [...this.mentionBuffer];
  }

  /**
   * Get unprocessed mentions (for responding)
   * Returns mentions that haven't been marked as processed
   */
  getUnprocessedMentions(): Mention[] {
    return this.mentionBuffer.filter(m => {
      // Filter out mentions older than 1 hour (stale)
      const hourAgo = Date.now() - 60 * 60 * 1000;
      return m.createdAt.getTime() > hourAgo;
    });
  }

  /**
   * Check if mention monitoring is active
   */
  isMentionMonitoringActive(): boolean {
    return !!(this.ownUserId && this.bearerToken && this.mentionPollInterval);
  }

  /**
   * Get own user info
   */
  getOwnUserInfo(): { userId: string; username: string } | null {
    if (!this.ownUserId) return null;
    return { userId: this.ownUserId, username: this.ownUsername };
  }
}
