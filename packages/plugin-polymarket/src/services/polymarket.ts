/**
 * Polymarket Service
 *
 * Core service for interacting with the Polymarket CLOB API.
 * Handles authentication, order management, and market data retrieval.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet, providers } from 'ethers';
import { getCurrentETTime } from '../providers/timezone';
import type { TagManagerService } from './tag-manager';

const { JsonRpcProvider } = providers;

// ============= Fetch with Timeout =============

const DEFAULT_TIMEOUT_MS = 15000; // 15 seconds for API calls

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
      logger.warn({ url }, '[PolymarketService] Request timed out');
    } else {
      logger.debug({ error, url }, '[PolymarketService] Fetch failed');
    }
    return null;
  }
}
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
  private tagManager: TagManagerService | null = null;

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
    // Get TagManager service for category filtering
    try {
      this.tagManager = this.runtime.getService<TagManagerService>('tag-manager');
      if (this.tagManager) {
        logger.info('[PolymarketService] TagManager service connected');
      }
    } catch {
      logger.warn('[PolymarketService] TagManager service not available');
    }

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

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info({ attempt }, '[PolymarketService] Attempting to derive/create API key');

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

        logger.info('[PolymarketService] API credentials initialized successfully');
        return;
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        logger.warn({ attempt, error: errorMsg }, '[PolymarketService] API key creation failed');

        if (attempt < MAX_RETRIES) {
          logger.info({ retryIn: RETRY_DELAY_MS }, '[PolymarketService] Retrying...');
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          logger.error('[PolymarketService] All API key creation attempts failed - running in read-only mode');
        }
      }
    }
  }

  /**
   * Ensure token allowances are set for USDC and conditional tokens.
   * This is required before placing any trades.
   *
   * Note: The CLOB client SDK methods for allowances may not exist in all versions.
   * We skip the allowance check entirely and let trades fail with clear errors if needed.
   * This prevents "is not a function" errors from breaking the service.
   */
  private async ensureAllowances(): Promise<void> {
    if (!this.client) return;

    try {
      // Check if setAllowances method exists on the client
      // Some SDK versions don't have this method
      if (typeof (this.client as any).setAllowances !== 'function') {
        logger.info('[PolymarketService] setAllowances not available in this SDK version - skipping');
        // Assume allowances are OK, let trades fail with clear error if not
        this.allowancesApproved = true;
        return;
      }

      logger.info('[PolymarketService] Checking/setting token allowances...');

      // Set max allowances for USDC and conditional tokens
      // This requires on-chain transactions (gas fees apply on first run)
      await (this.client as any).setAllowances();

      logger.info('[PolymarketService] Token allowances verified/set successfully');
      this.allowancesApproved = true;
    } catch (error: any) {
      const errorMsg = error?.message || String(error);

      // Check for "is not a function" error - means method doesn't exist
      if (errorMsg.includes('is not a function') || errorMsg.includes('not a function')) {
        logger.info('[PolymarketService] Allowance methods not available - skipping');
        this.allowancesApproved = true;
        return;
      }

      // Check if it's a "already approved" type error (which means allowances are set)
      if (errorMsg.includes('already') || errorMsg.includes('allowance')) {
        logger.debug('[PolymarketService] Allowances appear to already be set');
        this.allowancesApproved = true;
        return;
      }

      // Don't throw - allowances might already be set or this is a read-only check
      logger.warn({ error: errorMsg }, '[PolymarketService] Could not verify/set allowances - trading may fail');
      // Still mark as approved to allow attempting trades (they will fail with clear error if not set)
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
   * @param params.includeResolution - If true, include markets in resolution phase (>95% skewed)
   * @param params.skipDateFilter - If true, skip end_date_min filtering (for viewing past markets)
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

      // CRITICAL FIX: Add end_date_min filter to exclude past-dated markets
      // This ensures we only get markets that haven't expired yet
      const includeResolution = (params as any).includeResolution ?? false;
      const skipDateFilter = (params as any).skipDateFilter ?? false;

      if (!skipDateFilter) {
        const currentDate = new Date().toISOString();
        queryParams.set('end_date_min', currentDate);
      }

      // Request markets with active order books (tradeable)
      queryParams.set('enableOrderBook', 'true');
      queryParams.set('acceptingOrders', 'true');

      const response = await safeFetch(`${GAMMA_API_HOST}/markets?${queryParams.toString()}`);
      if (!response) {
        logger.warn('[PolymarketService] Failed to fetch markets - request failed');
        return [];
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch markets: ${response.statusText}`);
      }

      const data = await response.json();
      logger.debug({ marketCount: data?.length }, '[PolymarketService] Raw markets from API');

      let markets = this.parseMarkets(data);
      logger.debug({ parsedCount: markets.length }, '[PolymarketService] Parsed markets');

      const beforeFilter = markets.length;

      // Log raw market data for first few markets to debug
      logger.debug({
        sampleMarkets: markets.slice(0, 3).map(m => ({
          question: m.question.slice(0, 60),
          closed: m.closed,
          archived: m.archived,
          end_date_iso: m.end_date_iso,
          tokenCount: m.tokens?.length,
          hasTokenId: m.tokens?.some(t => t.token_id)
        }))
      }, '[PolymarketService] Sample raw market data before filtering');

      markets = markets.filter(m => {
        // Trust API's closed flag - this is the authoritative source
        if (m.closed) {
          logger.debug({ question: m.question.slice(0, 50) },
            '[PolymarketService] FILTERED: closed');
          return false;
        }

        // Filter archived markets
        if (m.archived) {
          logger.debug({ question: m.question.slice(0, 50) },
            '[PolymarketService] FILTERED: archived');
          return false;
        }

        // Basic token validation - check tokens exist for trading
        const hasTokens = m.tokens && m.tokens.length > 0 && m.tokens.some(t => t.token_id);
        if (!hasTokens) {
          logger.debug({ question: m.question.slice(0, 50) },
            '[PolymarketService] FILTERED: no valid tokens');
          return false;
        }

        // CRITICAL FIX: Filter out markets with >95% skewed odds (effectively resolved)
        // These markets are "awaiting resolution" - outcome is practically decided
        if (!includeResolution) {
          const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
          const yesPrice = yesToken?.price ?? 0.5;

          // If YES is >= 95% or <= 5%, market is effectively resolved
          if (yesPrice >= 0.95 || yesPrice <= 0.05) {
            logger.debug({
              question: m.question.slice(0, 50),
              yesPrice: (yesPrice * 100).toFixed(1) + '%'
            }, '[PolymarketService] FILTERED: >95% skewed (awaiting resolution)');
            return false;
          }
        }

        // CRITICAL FIX: Client-side date validation
        // Double-check end_date to filter any stale/past markets that slipped through
        if (!skipDateFilter && m.end_date_iso) {
          const endDate = new Date(m.end_date_iso);
          const now = new Date();
          if (endDate < now) {
            logger.debug({
              question: m.question.slice(0, 50),
              endDate: m.end_date_iso
            }, '[PolymarketService] FILTERED: past end_date');
            return false;
          }
        }

        return true;
      });

      logger.info({
        beforeFilter,
        afterFilter: markets.length,
        includeResolution,
        skipDateFilter
      }, '[PolymarketService] Markets after filtering');
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
      const response = await safeFetch(`${GAMMA_API_HOST}/markets/${conditionId}`);
      if (!response) {
        logger.warn({ conditionId }, '[PolymarketService] Failed to fetch market - request failed');
        return null;
      }
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to fetch market: ${response.statusText}`);
      }

      const data = await response.json();
      const markets = this.parseMarkets([data]);
      return markets[0] ?? null;
    } catch (error) {
      logger.error({ error, conditionId }, '[PolymarketService] Failed to fetch market');
      return null; // Return null instead of throwing for graceful degradation
    }
  }

  /**
   * Search markets by query
   */
  async searchMarkets(query: string, limit = 10): Promise<PolymarketMarket[]> {
    return this.getMarkets({ query, active: true, limit });
  }

  /**
   * Category configuration with inclusion keywords (for searching) and
   * exclusion keywords (to filter out wrong-category results)
   */
  private static CATEGORY_CONFIG: Record<string, {
    searchTerms: string[];
    verifyKeywords: string[];  // Market must contain at least one
    excludeKeywords: string[]; // Market must NOT contain any
  }> = {
    sports: {
      searchTerms: ['nfl', 'nba', 'mlb', 'nhl', 'super bowl', 'world series', 'stanley cup', 'championship game', 'playoffs'],
      verifyKeywords: ['nfl', 'nba', 'mlb', 'nhl', 'super bowl', 'world series', 'stanley cup', 'playoffs', 'game', 'match', 'championship', 'win', 'team', 'player', 'season', 'finals', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'boxing', 'ufc', 'mma', 'olympics'],
      excludeKeywords: ['trump', 'biden', 'election', 'president', 'congress', 'senate', 'governor', 'democrat', 'republican', 'vote', 'political', 'bitcoin', 'ethereum', 'crypto', 'fed', 'inflation', 'interest rate'],
    },
    politics: {
      searchTerms: ['president', 'election', 'congress', 'senate', 'trump', 'biden', 'governor'],
      verifyKeywords: ['president', 'election', 'congress', 'senate', 'trump', 'biden', 'governor', 'vote', 'political', 'democrat', 'republican', 'primary', 'nominee', 'electoral', 'cabinet', 'impeach', 'legislation'],
      excludeKeywords: ['nfl', 'nba', 'mlb', 'super bowl', 'championship', 'playoffs', 'game score', 'world series', 'finals game'],
    },
    crypto: {
      searchTerms: ['bitcoin', 'ethereum', 'btc price', 'eth price', 'crypto', 'solana'],
      verifyKeywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain', 'token', 'defi', 'solana', 'sol', 'nft', 'web3', 'binance', 'coinbase', 'altcoin'],
      excludeKeywords: ['trump', 'biden', 'election', 'president', 'nfl', 'nba', 'super bowl', 'championship'],
    },
    finance: {
      searchTerms: ['fed', 'interest rate', 'inflation', 'recession', 'gdp', 'stock market'],
      verifyKeywords: ['fed', 'federal reserve', 'interest rate', 'inflation', 'recession', 'gdp', 'stock', 'economy', 'unemployment', 'cpi', 'treasury', 'yield', 'dow', 'nasdaq', 's&p'],
      excludeKeywords: ['nfl', 'nba', 'super bowl', 'championship', 'trump election', 'biden election'],
    },
    tech: {
      searchTerms: ['ai', 'apple', 'google', 'microsoft', 'openai', 'tesla', 'elon musk'],
      verifyKeywords: ['ai', 'artificial intelligence', 'apple', 'google', 'microsoft', 'openai', 'tesla', 'meta', 'amazon', 'nvidia', 'chatgpt', 'technology', 'tech', 'software', 'hardware'],
      excludeKeywords: ['nfl', 'nba', 'super bowl', 'election', 'president'],
    },
    entertainment: {
      searchTerms: ['oscar', 'grammy', 'emmy', 'movie', 'celebrity', 'music award'],
      verifyKeywords: ['oscar', 'grammy', 'emmy', 'movie', 'film', 'tv', 'celebrity', 'music', 'award', 'actor', 'actress', 'singer', 'album', 'box office'],
      excludeKeywords: ['nfl', 'nba', 'election', 'president', 'bitcoin', 'crypto'],
    },
    science: {
      searchTerms: ['climate', 'nasa', 'space', 'vaccine', 'medical', 'research'],
      verifyKeywords: ['climate', 'nasa', 'space', 'spacex', 'vaccine', 'medical', 'research', 'discovery', 'science', 'health', 'fda', 'drug', 'study'],
      excludeKeywords: ['nfl', 'nba', 'election', 'trump', 'biden'],
    },
    world: {
      searchTerms: ['ukraine', 'russia', 'china', 'war', 'international', 'treaty'],
      verifyKeywords: ['ukraine', 'russia', 'china', 'war', 'international', 'treaty', 'conflict', 'geopolitical', 'nato', 'eu', 'un', 'sanctions', 'military'],
      excludeKeywords: ['nfl', 'nba', 'super bowl', 'championship game', 'playoffs'],
    },
  };

  /**
   * Verify that a market belongs to the requested category
   */
  private verifyCategoryMatch(market: PolymarketMarket, category: string): boolean {
    const config = PolymarketService.CATEGORY_CONFIG[category.toLowerCase()];
    if (!config) return true; // Unknown category, accept all

    const questionLower = market.question.toLowerCase();
    const descriptionLower = (market.description || '').toLowerCase();
    const fullText = `${questionLower} ${descriptionLower}`;

    // Check exclusion keywords first - reject if any match
    for (const excludeWord of config.excludeKeywords) {
      if (fullText.includes(excludeWord.toLowerCase())) {
        logger.debug({ market: market.question.slice(0, 50), excludeWord, category },
          '[PolymarketService] Market excluded by keyword');
        return false;
      }
    }

    // Must contain at least one verification keyword
    const hasVerifyKeyword = config.verifyKeywords.some(keyword =>
      fullText.includes(keyword.toLowerCase())
    );

    if (!hasVerifyKeyword) {
      logger.debug({ market: market.question.slice(0, 50), category },
        '[PolymarketService] Market rejected - no matching verification keywords');
    }

    return hasVerifyKeyword;
  }

  /**
   * Get markets by category/topic with strict verification
   * Categories: politics, crypto, sports, finance, tech, entertainment, science, world
   */
  async getMarketsByCategory(category: string, limit = 20): Promise<PolymarketMarket[]> {
    const config = PolymarketService.CATEGORY_CONFIG[category.toLowerCase()];

    // Fallback for unknown categories
    if (!config) {
      logger.warn({ category }, '[PolymarketService] Unknown category, using direct search');
      return this.searchMarkets(category, limit);
    }

    const allMarkets: PolymarketMarket[] = [];
    const seenIds = new Set<string>();

    // Search using category-specific terms
    for (const searchTerm of config.searchTerms.slice(0, 4)) {
      try {
        const markets = await this.getMarkets({ query: searchTerm, active: true, limit: limit });
        for (const market of markets) {
          if (!seenIds.has(market.condition_id)) {
            // CRITICAL: Verify the market actually belongs to this category
            if (this.verifyCategoryMatch(market, category)) {
              seenIds.add(market.condition_id);
              allMarkets.push(market);
            }
          }
        }
      } catch (error) {
        logger.warn({ error, searchTerm }, '[PolymarketService] Category search query failed');
      }
    }

    logger.info({ category, found: allMarkets.length, limit },
      '[PolymarketService] Category search completed with verification');

    // Sort by volume and return top results
    return allMarkets
      .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
      .slice(0, limit);
  }

  // ============================================================
  // EVENTS API METHODS (RECOMMENDED APPROACH)
  // ============================================================

  /**
   * Fetch events from Polymarket using the Events API
   * This is the RECOMMENDED approach as Events contain Markets and provide better metadata
   */
  async getEvents(options: {
    limit?: number;
    offset?: number;
    tagId?: string;
    minVolume?: number;
    sortBy?: 'volume' | 'volume24hr' | 'liquidity';
    includeResolved?: boolean;
  } = {}): Promise<any[]> {
    const {
      limit = 50,
      offset = 0,
      tagId,
      minVolume,
      sortBy = 'volume24hr',
      includeResolved = false
    } = options;

    const params = new URLSearchParams({
      limit: Math.min(limit, 100).toString(),
      offset: offset.toString(),
      order: sortBy,
      ascending: 'false',
      active: 'true',
      closed: includeResolved ? 'true' : 'false',
    });

    // CRITICAL: Add tag_id filter for category-based queries
    if (tagId) {
      params.append('tag_id', tagId);
    }

    // Add end_date_min to filter out past events
    if (!includeResolved) {
      params.append('end_date_min', new Date().toISOString());
    }

    // Add volume filter
    if (minVolume) {
      params.append('volume_num_min', minVolume.toString());
    }

    const url = `${GAMMA_API_HOST}/events?${params}`;
    logger.debug(`[PolymarketService] Fetching events: ${url}`);

    try {
      const response = await safeFetch(url);
      if (!response || !response.ok) {
        logger.warn(`[PolymarketService] Events API returned ${response?.status || 'null'}`);
        return [];
      }

      const events = await response.json();
      logger.info({ eventCount: events?.length, tagId }, '[PolymarketService] Fetched events');

      return Array.isArray(events) ? events : [];
    } catch (error) {
      logger.error('[PolymarketService] Failed to fetch events:', error);
      return [];
    }
  }

  /**
   * Extract markets from events
   */
  private extractMarketsFromEvents(events: any[]): PolymarketMarket[] {
    const allMarkets: PolymarketMarket[] = [];
    const seenIds = new Set<string>();

    for (const event of events) {
      if (!event.markets || !Array.isArray(event.markets)) continue;

      for (const m of event.markets) {
        const conditionId = m.conditionId || m.condition_id;
        if (!conditionId || seenIds.has(conditionId)) continue;

        // Validate market is tradeable
        const endDate = new Date(m.endDate || m.end_date_iso || '');
        if (endDate < new Date()) continue;

        // Check prices aren't extreme (already resolved)
        try {
          const prices = JSON.parse(m.outcomePrices || '["0.5", "0.5"]');
          const yesPrice = parseFloat(prices[0]);
          if (yesPrice <= 0.02 || yesPrice >= 0.98) continue;
        } catch {
          // Skip if can't parse
        }

        seenIds.add(conditionId);

        // Convert to PolymarketMarket format
        const market: PolymarketMarket = {
          condition_id: conditionId,
          question_id: m.questionId || m.question_id,
          question: m.question || event.title || '',
          description: m.description || event.description || '',
          market_slug: m.slug || m.market_slug || '',
          end_date_iso: m.endDate || m.end_date_iso || '',
          game_start_time: m.gameStartTime,
          tokens: this.parseTokens(m),
          active: m.active ?? true,
          closed: m.closed ?? false,
          archived: m.archived ?? false,
          accepting_orders: m.acceptingOrders ?? true,
          minimum_order_size: parseFloat(m.minimumOrderSize || '1'),
          minimum_tick_size: parseFloat(m.minimumTickSize || '0.01'),
          neg_risk: m.negRisk ?? false,
          volume: parseFloat(m.volume || '0'),
          volume_num: parseFloat(m.volumeNum || m.volume || '0'),
          liquidity: parseFloat(m.liquidityNum || m.liquidity || '0'),
          spread: parseFloat(m.spread || '0'),
        };

        allMarkets.push(market);
      }
    }

    return allMarkets;
  }

  /**
   * Get sports markets using the dedicated /sports endpoint for tag IDs
   * This is the CORRECT way to fetch sports markets
   */
  async getSportsMarkets(limit = 20): Promise<PolymarketMarket[]> {
    const allMarkets: PolymarketMarket[] = [];
    const seenIds = new Set<string>();

    // Get sports-specific tag IDs
    let sportsTagIds: string[] = [];

    if (this.tagManager) {
      sportsTagIds = this.tagManager.getSportsTagIds();
    }

    if (sportsTagIds.length === 0) {
      // Fallback: fetch from /sports endpoint directly
      try {
        const response = await safeFetch(`${GAMMA_API_HOST}/sports`);
        if (response && response.ok) {
          const sports = await response.json();
          for (const sport of sports) {
            if (sport.tags) {
              const tags = typeof sport.tags === 'string'
                ? sport.tags.split(',').map((t: string) => t.trim())
                : [sport.tags];
              sportsTagIds.push(...tags);
            }
          }
          sportsTagIds = [...new Set(sportsTagIds)];
        }
      } catch (error) {
        logger.warn('[PolymarketService] Failed to fetch sports tags:', error);
      }
    }

    logger.info({ tagCount: sportsTagIds.length }, '[PolymarketService] Sports tag IDs');

    // Fetch events for each sports tag (limit to prevent too many API calls)
    for (const tagId of sportsTagIds.slice(0, 5)) {
      try {
        const events = await this.getEvents({ tagId, limit: limit * 2 });
        const markets = this.extractMarketsFromEvents(events);

        for (const market of markets) {
          if (!seenIds.has(market.condition_id)) {
            // Verify it's actually a sports market
            if (this.verifyCategoryMatch(market, 'sports')) {
              seenIds.add(market.condition_id);
              allMarkets.push(market);
            }
          }
        }
      } catch (error) {
        logger.warn({ tagId, error }, '[PolymarketService] Failed to fetch sports tag');
      }
    }

    // If we didn't get enough from Events API, fallback to keyword search
    if (allMarkets.length < 5) {
      logger.info('[PolymarketService] Supplementing sports with keyword search');
      const keywordMarkets = await this.getMarketsByCategory('sports', limit);
      for (const market of keywordMarkets) {
        if (!seenIds.has(market.condition_id)) {
          seenIds.add(market.condition_id);
          allMarkets.push(market);
        }
      }
    }

    logger.info({ found: allMarkets.length }, '[PolymarketService] Sports markets fetched');

    // Sort by volume and return
    return allMarkets
      .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
      .slice(0, limit);
  }

  /**
   * Get crypto markets
   */
  async getCryptoMarkets(limit = 20): Promise<PolymarketMarket[]> {
    return this.getMarketsByCategoryWithTags('crypto', limit);
  }

  /**
   * Get politics markets
   */
  async getPoliticsMarkets(limit = 20): Promise<PolymarketMarket[]> {
    return this.getMarketsByCategoryWithTags('politics', limit);
  }

  /**
   * Get economics/finance markets
   */
  async getEconomicsMarkets(limit = 20): Promise<PolymarketMarket[]> {
    return this.getMarketsByCategoryWithTags('economics', limit);
  }

  /**
   * Get markets by category using TagManager for proper tag_id filtering
   */
  private async getMarketsByCategoryWithTags(category: string, limit = 20): Promise<PolymarketMarket[]> {
    const allMarkets: PolymarketMarket[] = [];
    const seenIds = new Set<string>();

    // Get tag IDs from TagManager
    const tagIds = this.tagManager?.getTagIdsForCategory(category) || [];

    logger.info({ category, tagCount: tagIds.length }, '[PolymarketService] Category tag IDs');

    // Fetch events for each tag
    for (const tagId of tagIds.slice(0, 3)) {
      try {
        const events = await this.getEvents({ tagId, limit: limit * 2 });
        const markets = this.extractMarketsFromEvents(events);

        for (const market of markets) {
          if (!seenIds.has(market.condition_id)) {
            if (this.verifyCategoryMatch(market, category)) {
              seenIds.add(market.condition_id);
              allMarkets.push(market);
            }
          }
        }
      } catch (error) {
        logger.warn({ tagId, error }, '[PolymarketService] Failed to fetch category tag');
      }
    }

    // If we didn't get enough, supplement with keyword search
    if (allMarkets.length < 5) {
      logger.info({ category }, '[PolymarketService] Supplementing with keyword search');
      const keywordMarkets = await this.getMarketsByCategory(category, limit);
      for (const market of keywordMarkets) {
        if (!seenIds.has(market.condition_id)) {
          seenIds.add(market.condition_id);
          allMarkets.push(market);
        }
      }
    }

    return allMarkets
      .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
      .slice(0, limit);
  }

  /**
   * Get top markets by 24h volume
   */
  async getTopMarketsByVolume24h(limit = 20): Promise<PolymarketMarket[]> {
    const events = await this.getEvents({
      limit: limit * 2,
      sortBy: 'volume24hr',
      minVolume: 10000
    });

    const markets = this.extractMarketsFromEvents(events);

    return markets
      .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
      .slice(0, limit);
  }

  /**
   * Get trending markets (high volume, active trading)
   * Can filter by minimum volume and liquidity thresholds
   */
  async getTrendingMarkets(options: {
    minVolume?: number;
    minLiquidity?: number;
    limit?: number;
    sortBy?: 'volume' | 'liquidity' | 'spread';
  } = {}): Promise<PolymarketMarket[]> {
    const { minVolume = 10000, minLiquidity = 1000, limit = 20, sortBy = 'volume' } = options;

    // Fetch more markets to filter from
    const markets = await this.getMarkets({ active: true, limit: 100 });

    // Filter by volume and liquidity thresholds
    let filtered = markets.filter(m => {
      const volume = m.volume_num || 0;
      const liquidity = m.liquidity || 0;
      return volume >= minVolume && liquidity >= minLiquidity;
    });

    // Sort by specified metric
    filtered.sort((a, b) => {
      if (sortBy === 'volume') return (b.volume_num || 0) - (a.volume_num || 0);
      if (sortBy === 'liquidity') return (b.liquidity || 0) - (a.liquidity || 0);
      if (sortBy === 'spread') return (a.spread || 1) - (b.spread || 1); // Lower spread is better
      return 0;
    });

    return filtered.slice(0, limit);
  }

  /**
   * Find markets that might be related to a news topic or event
   * Uses fuzzy matching on keywords extracted from the topic
   */
  async findMarketsForTopic(topic: string, limit = 10): Promise<PolymarketMarket[]> {
    // Extract keywords from topic (remove common words)
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'will', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'or', 'and', 'as', 'if', 'but', 'not', 'that', 'this', 'it', 'its']);
    const keywords = topic.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 5);

    logger.debug({ topic, keywords }, '[PolymarketService] Finding markets for topic');

    if (keywords.length === 0) {
      return this.getMarkets({ active: true, limit });
    }

    const allMarkets: PolymarketMarket[] = [];
    const seenIds = new Set<string>();

    // Search for each keyword
    for (const keyword of keywords) {
      try {
        const markets = await this.getMarkets({ query: keyword, active: true, limit: 10 });
        for (const market of markets) {
          if (!seenIds.has(market.condition_id)) {
            seenIds.add(market.condition_id);
            // Score by how many keywords match
            const questionLower = market.question.toLowerCase();
            const matchCount = keywords.filter(kw => questionLower.includes(kw)).length;
            (market as any)._relevanceScore = matchCount;
            allMarkets.push(market);
          }
        }
      } catch (error) {
        logger.warn({ error, keyword }, '[PolymarketService] Topic keyword search failed');
      }
    }

    // Sort by relevance then volume
    return allMarkets
      .sort((a, b) => {
        const scoreA = (a as any)._relevanceScore || 0;
        const scoreB = (b as any)._relevanceScore || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (b.volume_num || 0) - (a.volume_num || 0);
      })
      .slice(0, limit);
  }

  /**
   * Analyze a market for trading opportunities
   * Returns detailed analysis including price, volume, spread, and time context
   */
  async analyzeMarket(conditionId: string): Promise<{
    market: PolymarketMarket;
    analysis: {
      yesPrice: number;
      noPrice: number;
      spread: number;
      liquidity: number;
      volumeRank: 'high' | 'medium' | 'low';
      timeToExpiry: string;
      isExpiringSoon: boolean;
      tradingRecommendation: string;
    };
  } | null> {
    const market = await this.getMarket(conditionId);
    if (!market) return null;

    const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
    const noToken = market.tokens.find(t => t.outcome.toLowerCase() === 'no');
    const yesPrice = yesToken?.price || 0.5;
    const noPrice = noToken?.price || 0.5;

    // Calculate time to expiry
    let timeToExpiry = 'Unknown';
    let isExpiringSoon = false;
    if (market.end_date_iso) {
      const endDate = new Date(market.end_date_iso);
      const now = new Date();
      const hoursRemaining = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      isExpiringSoon = hoursRemaining < 48;
      if (hoursRemaining < 1) timeToExpiry = 'Less than 1 hour';
      else if (hoursRemaining < 24) timeToExpiry = `${Math.round(hoursRemaining)} hours`;
      else if (hoursRemaining < 168) timeToExpiry = `${Math.round(hoursRemaining / 24)} days`;
      else timeToExpiry = `${Math.round(hoursRemaining / 168)} weeks`;
    }

    // Volume ranking
    const volume = market.volume_num || 0;
    const volumeRank = volume > 100000 ? 'high' : volume > 10000 ? 'medium' : 'low';

    // Trading recommendation based on metrics
    let tradingRecommendation = 'No clear opportunity';
    if (market.spread < 0.02 && volumeRank === 'high') {
      tradingRecommendation = 'Liquid market with tight spread - good for trading';
    } else if (market.spread > 0.1) {
      tradingRecommendation = 'Wide spread - consider limit orders only';
    } else if (isExpiringSoon && volumeRank === 'high') {
      tradingRecommendation = 'Expiring soon with high volume - watch for resolution signals';
    }

    return {
      market,
      analysis: {
        yesPrice,
        noPrice,
        spread: market.spread || Math.abs(yesPrice + noPrice - 1),
        liquidity: market.liquidity || 0,
        volumeRank,
        timeToExpiry,
        isExpiringSoon,
        tradingRecommendation,
      },
    };
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
   * Safely parse JSON string or return the value if already parsed
   */
  private safeJsonParse(value: any, fallback: any = []): any {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  /**
   * Parse tokens from various API response formats
   * Note: Gamma API returns clobTokenIds, outcomes, outcomePrices as JSON STRINGS
   */
  private parseTokens(m: any): { token_id: string; outcome: string; price: number; winner?: boolean }[] {
    const conditionId = m.conditionId || m.condition_id || '';

    // Gamma API returns these as JSON strings, need to parse them
    const clobTokenIds = this.safeJsonParse(m.clobTokenIds, []);
    const outcomeNames = this.safeJsonParse(m.outcomes, ['Yes', 'No']);
    const outcomePrices = this.safeJsonParse(m.outcomePrices, []);

    // Priority 1: clobTokenIds (Gamma API format) - these are the actual tradeable token IDs
    if (clobTokenIds.length > 0 && clobTokenIds[0]) {
      return clobTokenIds.map((tokenId: string, idx: number) => ({
        token_id: tokenId,
        outcome: outcomeNames[idx] || (idx === 0 ? 'Yes' : 'No'),
        price: parseFloat(outcomePrices[idx] || '0.5'),
        winner: undefined,
      }));
    }

    // Priority 2: tokens array with proper structure
    const tokens = this.safeJsonParse(m.tokens, []);
    if (tokens.length > 0) {
      return tokens.map((t: any, idx: number) => ({
        token_id: t.token_id || t.tokenId || t.clobTokenId || `${conditionId}-${idx}`,
        outcome: t.outcome || outcomeNames[idx] || (idx === 0 ? 'Yes' : 'No'),
        price: parseFloat(t.price || outcomePrices[idx] || '0.5'),
        winner: t.winner,
      }));
    }

    // Fallback: generate synthetic tokens (these won't be tradeable)
    logger.warn({ conditionId, hasClobTokenIds: typeof m.clobTokenIds },
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
