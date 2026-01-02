/**
 * Lightweight Twitter Service
 *
 * Posts trade notifications to Twitter using OAuth 1.0a.
 * Uses fetch directly to avoid dependency issues.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import * as crypto from 'crypto';

// ============= Fetch with Timeout =============

const DEFAULT_TIMEOUT_MS = 15000; // 15 seconds

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
      logger.warn({ url }, '[Twitter] Request timed out');
    } else {
      logger.debug({ error, url }, '[Twitter] Fetch failed');
    }
    return null;
  }
}

export interface TweetResult {
  id: string;
  text: string;
  url: string;
}

export class TwitterService extends Service {
  static override readonly serviceType = 'twitter';
  override capabilityDescription = 'Posts trade notifications to Twitter';

  static async start(runtime: IAgentRuntime): Promise<TwitterService> {
    const service = new TwitterService();
    await service.initialize(runtime);
    return service;
  }

  private runtime: IAgentRuntime | null = null;
  private apiKey: string | null = null;
  private apiSecret: string | null = null;
  private accessToken: string | null = null;
  private accessTokenSecret: string | null = null;

  constructor() {
    super();
  }

  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[Twitter] Initializing Twitter service');
    this.runtime = runtime;

    this.apiKey = process.env.TWITTER_API_KEY || null;
    this.apiSecret = process.env.TWITTER_API_SECRET_KEY || null;
    this.accessToken = process.env.TWITTER_ACCESS_TOKEN || null;
    this.accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET || null;

    if (!this.apiKey || !this.apiSecret || !this.accessToken || !this.accessTokenSecret) {
      logger.warn('[Twitter] Twitter credentials not fully configured - posting disabled');
    } else {
      logger.info('[Twitter] Twitter API configured successfully');
    }
  }

  override async stop(): Promise<void> {
    logger.info('[Twitter] Stopping Twitter service');
  }

  /**
   * Check if Twitter is available
   */
  isAvailable(): boolean {
    return !!(this.apiKey && this.apiSecret && this.accessToken && this.accessTokenSecret);
  }

  /**
   * Generate OAuth 1.0a signature
   */
  private generateOAuthSignature(
    method: string,
    url: string,
    params: Record<string, string>,
    consumerSecret: string,
    tokenSecret: string
  ): string {
    // Sort parameters
    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');

    // Create signature base string
    const signatureBaseString = [
      method.toUpperCase(),
      encodeURIComponent(url),
      encodeURIComponent(sortedParams),
    ].join('&');

    // Create signing key
    const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

    // Generate HMAC-SHA1 signature
    const hmac = crypto.createHmac('sha1', signingKey);
    hmac.update(signatureBaseString);
    return hmac.digest('base64');
  }

  /**
   * Generate OAuth 1.0a header
   */
  private generateOAuthHeader(method: string, url: string, additionalParams: Record<string, string> = {}): string {
    if (!this.apiKey || !this.apiSecret || !this.accessToken || !this.accessTokenSecret) {
      throw new Error('Twitter credentials not configured');
    }

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: this.accessToken,
      oauth_version: '1.0',
      ...additionalParams,
    };

    // Generate signature
    const signature = this.generateOAuthSignature(
      method,
      url,
      oauthParams,
      this.apiSecret,
      this.accessTokenSecret
    );

    oauthParams.oauth_signature = signature;

    // Build OAuth header
    const headerParts = Object.keys(oauthParams)
      .filter((key) => key.startsWith('oauth_'))
      .sort()
      .map((key) => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
      .join(', ');

    return `OAuth ${headerParts}`;
  }

  /**
   * Post a tweet
   */
  async tweet(text: string): Promise<TweetResult | null> {
    if (!this.isAvailable()) {
      logger.warn('[Twitter] Cannot post tweet - not configured');
      return null;
    }

    const url = 'https://api.twitter.com/2/tweets';

    try {
      const authHeader = this.generateOAuthHeader('POST', url);

      const response = await safeFetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response) {
        logger.error('[Twitter] Tweet request failed (timeout or network error)');
        return null;
      }

      if (!response.ok) {
        const error = await response.text();
        logger.error({ status: response.status, error }, '[Twitter] Failed to post tweet');
        return null;
      }

      const data = await response.json() as { data: { id: string; text: string } };

      logger.info({ tweetId: data.data.id }, '[Twitter] Tweet posted successfully');

      return {
        id: data.data.id,
        text: data.data.text,
        url: `https://twitter.com/i/status/${data.data.id}`,
      };
    } catch (error) {
      logger.error({ error }, '[Twitter] Error posting tweet');
      return null;
    }
  }

  /**
   * Post a trade notification tweet
   */
  async postTradeNotification(trade: {
    market: string;
    direction: 'BUY_YES' | 'BUY_NO';
    amount: number;
    price: number;
    confidence: number;
    reasoning: string;
  }): Promise<TweetResult | null> {
    const directionEmoji = trade.direction === 'BUY_YES' ? '🟢' : '🔴';
    const directionText = trade.direction === 'BUY_YES' ? 'YES' : 'NO';

    // Build tweet text - Twitter limit is 280 chars
    let tweetText = `${directionEmoji} Bought ${directionText} on @Polymarket

"${trade.market.slice(0, 80)}${trade.market.length > 80 ? '...' : ''}"

💰 $${trade.amount.toFixed(2)} @ ${(trade.price * 100).toFixed(1)}%
📊 Confidence: ${trade.confidence}%

${trade.reasoning.slice(0, 100)}${trade.reasoning.length > 100 ? '...' : ''}

#Polymarket #PredictionMarkets`;

    // Truncate if too long
    if (tweetText.length > 280) {
      tweetText = tweetText.slice(0, 277) + '...';
    }

    return this.tweet(tweetText);
  }
}

export const twitterService = new TwitterService();
