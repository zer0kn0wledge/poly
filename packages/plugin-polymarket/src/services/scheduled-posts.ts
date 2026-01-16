/**
 * Scheduled Posts Service - CRYPTO PRICE ANALYSIS ONLY
 *
 * Handles scheduled Twitter posts for crypto price predictions:
 * - Posts crypto price analysis with technical indicators
 * - Uses CoinGecko data and edge calculations
 * - NO politics, NO sports - ONLY crypto price predictions
 */

import { Service, logger, type IAgentRuntime, ModelType } from '@elizaos/core';
import { getCurrentETTime } from '../providers/timezone';
import { TwitterService } from './twitter';
import { EdgeCalculatorService, type TradingOpportunity } from './edge-calculator.service';
import { CoinGeckoDataService } from './coingecko-data.service';
import { CryptoMarketDiscoveryService, type CryptoPriceMarket } from './crypto-market-discovery.service';

// ============= Types =============

interface ScheduledPost {
  id: string;
  type: 'DAILY_UPDATE' | 'WEEKLY_SUMMARY' | 'MARKET_UPDATE';
  scheduledTime: Date;
  completed: boolean;
  tweetId?: string;
  content?: string;
}

// ============= Service Implementation =============

export class ScheduledPostsService extends Service {
  static override readonly serviceType = 'scheduled-posts';
  override capabilityDescription = 'Handles scheduled Twitter posts for daily updates and weekly summaries';

  static async start(runtime: IAgentRuntime): Promise<ScheduledPostsService> {
    const service = new ScheduledPostsService();
    await service.initialize(runtime);
    return service;
  }

  private runtime: IAgentRuntime | null = null;
  private scheduledPosts: Map<string, ScheduledPost> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastMarketUpdateHour: number = -1; // Track last hour we posted

  private readonly DAILY_UPDATE_HOUR = 9; // 9 AM ET
  private readonly WEEKLY_SUMMARY_HOUR = 18; // 6 PM ET
  private readonly WEEKLY_SUMMARY_DAY = 5; // Friday (0 = Sunday)
  private readonly MARKET_UPDATE_INTERVAL_HOURS = 2; // Post every 2 hours
  private readonly MARKET_UPDATE_START_HOUR = 8; // Start at 8 AM ET
  private readonly MARKET_UPDATE_END_HOUR = 22; // End at 10 PM ET

  constructor() {
    super();
  }

  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[ScheduledPosts] Initializing scheduled posts service');
    this.runtime = runtime;

    // Wait for dependent services to become available
    await this.waitForServices();

    const etTime = getCurrentETTime();
    logger.info({
      currentHour: etTime.hour,
      currentTime: etTime.timeStr,
      marketUpdateHours: '8, 10, 12, 14, 16, 18, 20, 22',
      dailyUpdateHour: this.DAILY_UPDATE_HOUR,
      weeklySummaryHour: this.WEEKLY_SUMMARY_HOUR,
    }, '[ScheduledPosts] Schedule configuration');

    // Start checking for scheduled posts every minute
    this.checkInterval = setInterval(() => {
      this.checkAndExecuteScheduledPosts().catch((error) => {
        logger.error({ error }, '[ScheduledPosts] Error checking scheduled posts');
      });
    }, 60 * 1000); // Check every minute

    // Also do an immediate check (with delay to let other services finish init)
    setTimeout(() => {
      logger.info('[ScheduledPosts] Running initial check after startup delay');
      this.checkAndExecuteScheduledPosts().catch((error) => {
        logger.error({ error }, '[ScheduledPosts] Error in initial check');
      });
    }, 10000); // 10 second delay
  }

  /**
   * Wait for required services to become available
   */
  private async waitForServices(maxWaitMs: number = 30000): Promise<void> {
    const requiredServices = ['crypto-market-discovery', 'twitter'];
    const startTime = Date.now();

    logger.info('[ScheduledPosts] Waiting for required crypto services...', { requiredServices });

    while (Date.now() - startTime < maxWaitMs) {
      if (!this.runtime) break;

      const missing = requiredServices.filter(
        name => !this.runtime!.getService(name)
      );

      if (missing.length === 0) {
        logger.info('[ScheduledPosts] All required services available');
        return;
      }

      logger.debug('[ScheduledPosts] Waiting for services', { missing });
      await this.sleep(1000);
    }

    // Log which services are still missing
    if (!this.runtime) return;

    const stillMissing = requiredServices.filter(
      name => !this.runtime!.getService(name)
    );

    if (stillMissing.length > 0) {
      logger.warn('[ScheduledPosts] Some services unavailable after timeout', {
        missing: stillMissing,
        availableServices: requiredServices.filter(name => this.runtime!.getService(name))
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  override async stop(): Promise<void> {
    logger.info('[ScheduledPosts] Stopping scheduled posts service');
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  // ============= Schedule Checking =============

  private async checkAndExecuteScheduledPosts(): Promise<void> {
    const etTime = getCurrentETTime();

    // Check for 2-hour market updates (8 AM to 10 PM ET, every 2 hours)
    if (this.shouldPostMarketUpdate(etTime.hour)) {
      await this.postMarketUpdate();
      this.lastMarketUpdateHour = etTime.hour;
    }

    // Check for daily update (9 AM ET on weekdays) - skip if we just posted a market update
    if (
      etTime.hour === this.DAILY_UPDATE_HOUR &&
      !etTime.isWeekend &&
      !this.hasPostedToday('DAILY_UPDATE', etTime.dateStr)
    ) {
      // Daily update is more comprehensive, so skip the regular market update at 9 AM
      await this.postDailyUpdate();
      this.lastMarketUpdateHour = etTime.hour; // Prevent duplicate posting
    }

    // Check for weekly summary (Friday 6 PM ET)
    if (
      etTime.hour === this.WEEKLY_SUMMARY_HOUR &&
      etTime.date.getDay() === this.WEEKLY_SUMMARY_DAY &&
      !this.hasPostedThisWeek('WEEKLY_SUMMARY', etTime.date)
    ) {
      await this.postWeeklySummary();
    }
  }

  /**
   * Check if we should post a market update based on the 2-hour schedule
   */
  private shouldPostMarketUpdate(currentHour: number): boolean {
    // Only during active hours
    if (currentHour < this.MARKET_UPDATE_START_HOUR || currentHour > this.MARKET_UPDATE_END_HOUR) {
      return false;
    }

    // Check if this is a 2-hour interval hour (8, 10, 12, 14, 16, 18, 20, 22)
    if (currentHour % this.MARKET_UPDATE_INTERVAL_HOURS !== 0) {
      return false;
    }

    // Don't post if we already posted this hour
    if (this.lastMarketUpdateHour === currentHour) {
      return false;
    }

    // Don't post at daily update hour (9 AM) - let daily update handle it
    if (currentHour === this.DAILY_UPDATE_HOUR) {
      return false;
    }

    return true;
  }

  private hasPostedToday(type: string, dateStr: string): boolean {
    for (const post of this.scheduledPosts.values()) {
      if (post.type === type && post.completed) {
        const postDateStr = post.scheduledTime.toISOString().split('T')[0];
        if (postDateStr === dateStr) return true;
      }
    }
    return false;
  }

  private hasPostedThisWeek(type: string, date: Date): boolean {
    const weekStart = this.getWeekStart(date);
    for (const post of this.scheduledPosts.values()) {
      if (post.type === type && post.completed) {
        const postWeekStart = this.getWeekStart(post.scheduledTime);
        if (postWeekStart.getTime() === weekStart.getTime()) return true;
      }
    }
    return false;
  }

  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ============= Daily Update =============

  async postDailyUpdate(): Promise<string | null> {
    if (!this.runtime) return null;

    const etTime = getCurrentETTime();
    logger.info('[ScheduledPosts] Generating daily Polymarket update', { date: etTime.dateStr });

    const polymarketService = this.runtime.getService<PolymarketService>('polymarket');
    const twitterService = this.runtime.getService<TwitterService>('twitter');
    const dataSourcesService = this.runtime.getService<DataSourcesService>('data-sources');

    if (!polymarketService || !twitterService?.isAvailable()) {
      logger.warn('[ScheduledPosts] Required services not available for daily update');
      return null;
    }

    try {
      // Get top markets by volume
      const rawMarkets = await polymarketService.getMarkets({ active: true, limit: 50 });

      // Filter expired and past-year markets
      const validMarkets = rawMarkets.filter((market) => {
        if (isMarketExpired(market.end_date_iso)) return false;
        if (detectPastYearMarket(market.question, etTime.year).isPast) return false;
        return true;
      });

      // Sort by 24h volume (approximated by total volume if not available)
      const topMarkets = validMarkets
        .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
        .slice(0, 5);

      if (topMarkets.length === 0) {
        logger.warn('[ScheduledPosts] No valid markets for daily update');
        return null;
      }

      // Get news context for assessment
      let newsContext = '';
      if (dataSourcesService) {
        const news = await dataSourcesService.getAllNews();
        newsContext = news.slice(0, 10).map((n) => `- ${n.title}`).join('\n');
      }

      // Generate market assessments using LLM
      const content = await this.generateDailyUpdateContent(topMarkets, newsContext);

      if (!content) {
        logger.warn('[ScheduledPosts] Failed to generate daily update content');
        return null;
      }

      // Post to Twitter
      const result = await twitterService.tweet(content);

      // Record the post
      const postId = crypto.randomUUID();
      this.scheduledPosts.set(postId, {
        id: postId,
        type: 'DAILY_UPDATE',
        scheduledTime: etTime.date,
        completed: true,
        tweetId: result?.id,
        content,
      });

      logger.info({ tweetId: result?.id }, '[ScheduledPosts] Daily update posted');
      return result?.id || null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] Failed to post daily update');
      return null;
    }
  }

  // ============= 2-Hour Crypto Market Update =============

  /**
   * Post a crypto price market update every 2 hours
   */
  async postMarketUpdate(): Promise<string | null> {
    if (!this.runtime) return null;

    const etTime = getCurrentETTime();
    logger.info('[ScheduledPosts] Generating crypto price market update', { hour: etTime.hour, date: etTime.dateStr });

    const edgeCalculator = this.runtime.getService<EdgeCalculatorService>('edge-calculator');
    const discoveryService = this.runtime.getService<CryptoMarketDiscoveryService>('crypto-market-discovery');
    const twitterService = this.runtime.getService<TwitterService>('twitter');

    if (!twitterService?.isAvailable()) {
      logger.warn('[ScheduledPosts] Twitter service not available');
      return null;
    }

    try {
      let content: string | null = null;

      // Try to get opportunities with edge calculation
      if (edgeCalculator) {
        const opportunities = await edgeCalculator.findOpportunities();
        const topOpp = opportunities.find(o => o.rating === 'STRONG_BUY' || o.rating === 'BUY');

        if (topOpp) {
          content = this.formatCryptoOpportunityTweet(topOpp, etTime);
        }
      }

      // Fallback to discovery service
      if (!content && discoveryService) {
        const markets = await discoveryService.getCryptoPriceMarkets(1000, 5000);
        if (markets.length > 0) {
          content = this.formatCryptoMarketTweet(markets.slice(0, 3), etTime);
        }
      }

      if (!content) {
        logger.warn('[ScheduledPosts] No crypto markets for update');
        return null;
      }

      // Post to Twitter
      const result = await twitterService.tweet(content);

      // Record the post
      const postId = crypto.randomUUID();
      this.scheduledPosts.set(postId, {
        id: postId,
        type: 'MARKET_UPDATE',
        scheduledTime: etTime.date,
        completed: true,
        tweetId: result?.id,
        content,
      });

      logger.info({ tweetId: result?.id, hour: etTime.hour }, '[ScheduledPosts] Crypto update posted');
      return result?.id || null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] Failed to post crypto update');
      return null;
    }
  }

  /**
   * Format opportunity into tweet
   */
  private formatCryptoOpportunityTweet(
    opp: TradingOpportunity,
    etTime: ReturnType<typeof getCurrentETTime>
  ): string {
    const coin = opp.market.coinSymbol;
    const price = opp.currentPrice.toLocaleString();
    const target = opp.targetPrice.toLocaleString();
    const ta = opp.technicalAnalysis;
    const edgePct = opp.edge > 0 ? `+${opp.edgePercent.toFixed(0)}` : opp.edgePercent.toFixed(0);

    let tweet = `${coin} Price Analysis (${etTime.timeStr} ET)\n\n`;
    tweet += `Current: $${price}\n`;
    tweet += `Target: $${target}\n`;
    tweet += `RSI: ${ta.rsi.toFixed(0)} | MACD: ${ta.macdSignal}\n`;
    tweet += `Market: ${(opp.marketImpliedProbability * 100).toFixed(0)}% | TA Model: ${(opp.estimatedProbability * 100).toFixed(0)}%\n`;
    tweet += `Edge: ${edgePct}% | ${opp.rating}`;

    return tweet.slice(0, 280);
  }

  /**
   * Format crypto markets into tweet
   */
  private formatCryptoMarketTweet(
    markets: CryptoPriceMarket[],
    etTime: ReturnType<typeof getCurrentETTime>
  ): string {
    let tweet = `Crypto Price Markets (${etTime.timeStr} ET)\n\n`;

    for (const m of markets.slice(0, 2)) {
      tweet += `${m.coinSymbol}: $${m.targetPrice.toLocaleString()} target\n`;
      tweet += `${(m.yesPrice * 100).toFixed(0)}% YES | $${(m.volume / 1000).toFixed(0)}K vol\n\n`;
    }

    return tweet.trim().slice(0, 280);
  }

  private async generateMarketUpdateContent(
    markets: PolymarketMarket[],
    etTime: ReturnType<typeof getCurrentETTime>
  ): Promise<string | null> {
    if (!this.runtime) return null;

    // Format market data
    const marketsText = markets.map((m, i) => {
      const yesToken = m.tokens.find((t) => t.outcome.toLowerCase() === 'yes');
      const yesPrice = yesToken?.price || 0.5;
      const vol = m.volume_num >= 1000000
        ? `$${(m.volume_num / 1000000).toFixed(1)}M`
        : `$${((m.volume_num || 0) / 1000).toFixed(0)}K`;
      return `${i + 1}. "${m.question.slice(0, 60)}" - ${(yesPrice * 100).toFixed(0)}% YES (${vol} vol)`;
    }).join('\n');

    const prompt = `You are Zeracle, an elite prediction market analyst. Generate a market update tweet.

Time: ${etTime.timeStr} ET

TOP MARKETS:
${marketsText}

REQUIREMENTS - READ CAREFULLY:
1. Use FULL 280 characters - do NOT cut short. Target 260-280 chars.
2. Lead with an INSIGHT, not just "Market Update"
3. Include specific numbers: odds, volume, price movements
4. Explain WHY something is interesting (smart money, mispricing, catalyst)
5. Sound like a Bloomberg terminal note - professional, analytical
6. NO emojis, NO hashtags, NO exclamation marks

BAD (too short/generic): "Markets looking interesting today. Some movement in various sectors."
GOOD (specific/insightful): "Super Bowl odds diverging from public sentiment: Patriots at 8% despite $8.3M volume suggests institutional accumulation. Texans at 5% looks underpriced given AFC South dynamics."

Minimum 250 characters. Use the full space.
Return ONLY the tweet text.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      if (typeof response === 'string') {
        // Remove any emojis, hashtags, and action tags that might slip through
        const cleaned = response
          // CRITICAL: Remove leaked action tags
          .replace(/<actions>[\s\S]*?<\/actions>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
          .replace(/[\u{2600}-\u{27BF}]/gu, '')
          .replace(/#\w+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return cleaned.slice(0, 280);
      }
      return null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] LLM failed for market update');

      // Fallback: generate simple update
      const topMarket = markets[0];
      const yesPrice = topMarket.tokens.find((t) => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
      const vol = topMarket.volume_num >= 1000000
        ? `$${(topMarket.volume_num / 1000000).toFixed(1)}M`
        : `$${((topMarket.volume_num || 0) / 1000).toFixed(0)}K`;

      return `Market Update (${etTime.timeStr} ET)

Top market: "${topMarket.question.slice(0, 80)}"
${(yesPrice * 100).toFixed(0)}% YES | ${vol} volume`.slice(0, 280);
    }
  }

  private async generateDailyUpdateContent(
    markets: PolymarketMarket[],
    newsContext: string
  ): Promise<string | null> {
    if (!this.runtime) return null;

    const etTime = getCurrentETTime();

    const marketsText = markets.map((m, i) => {
      const yesToken = m.tokens.find((t) => t.outcome.toLowerCase() === 'yes');
      const yesPrice = yesToken?.price || 0.5;
      const timeContext = m.end_date_iso ? getRelativeTimeContext(new Date(m.end_date_iso)) : '';
      return `${i + 1}. "${m.question.slice(0, 80)}${m.question.length > 80 ? '...' : ''}"
   YES: ${(yesPrice * 100).toFixed(0)}% | Vol: $${((m.volume_num || 0) / 1000).toFixed(0)}k | ${timeContext}`;
    }).join('\n');

    const prompt = `You are Zeracle, an elite prediction market analyst. Generate a daily market briefing tweet.

Date: ${etTime.dayOfWeek}, ${etTime.dateStr}

TOP MARKETS BY VOLUME:
${marketsText}

RELEVANT NEWS:
${newsContext || 'No significant news.'}

REQUIREMENTS - READ CAREFULLY:
1. Use FULL 280 characters - target 260-280 chars
2. Lead with your sharpest insight about today's markets
3. Highlight 2-3 specific markets with exact odds (e.g., "67% YES")
4. Include volume figures where notable (e.g., "$2.1M volume")
5. Explain WHY odds are interesting (mispricing, smart money divergence, upcoming catalyst)
6. Sound like a Bloomberg morning note - professional, precise, analytical
7. NO emojis, NO hashtags, NO exclamation marks

BAD (generic): "Good morning! Markets are active today with several interesting opportunities."
GOOD (specific): "Morning brief: BTC $100K by March at 41% looks mispriced given ETF inflows. Trump nomination market seeing unusual volume at 67% - smart money positioning ahead of primaries. Watch Fed odds post-FOMC."

Minimum 250 characters. Use the full character limit.
Return ONLY the tweet text.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      if (typeof response === 'string') {
        // Remove any emojis, hashtags, and action tags that might slip through
        const cleaned = response
          // CRITICAL: Remove leaked action tags
          .replace(/<actions>[\s\S]*?<\/actions>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
          .replace(/[\u{2600}-\u{27BF}]/gu, '')
          .replace(/#\w+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return cleaned.slice(0, 280);
      }
      return null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] LLM failed for daily update');

      // Fallback: generate simple update
      const top3 = markets.slice(0, 3);
      const fallback = `Daily Brief (${etTime.dateStr})

${top3.map((m, i) => {
  const yesPrice = m.tokens.find((t) => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
  return `${i + 1}. ${m.question.slice(0, 55)}... - ${(yesPrice * 100).toFixed(0)}%`;
}).join('\n')}`;

      return fallback.slice(0, 280);
    }
  }

  // ============= Weekly Summary =============

  async postWeeklySummary(): Promise<string | null> {
    if (!this.runtime) return null;

    const etTime = getCurrentETTime();
    logger.info('[ScheduledPosts] Generating weekly trade summary', { date: etTime.dateStr });

    const twitterService = this.runtime.getService<TwitterService>('twitter');
    const strategyService = this.runtime.getService<StrategyLearningService>('strategy-learning');

    if (!twitterService?.isAvailable()) {
      logger.warn('[ScheduledPosts] Twitter service not available for weekly summary');
      return null;
    }

    try {
      // Get weekly stats
      let weeklyStats: WeeklyStats | null = null;
      if (strategyService) {
        weeklyStats = strategyService.getWeeklyStats();
      }

      // Generate content
      const content = await this.generateWeeklySummaryContent(weeklyStats);

      if (!content) {
        logger.warn('[ScheduledPosts] Failed to generate weekly summary content');
        return null;
      }

      // Post to Twitter (might need multiple tweets for thread)
      const result = await twitterService.tweet(content);

      // Record the post
      const postId = crypto.randomUUID();
      this.scheduledPosts.set(postId, {
        id: postId,
        type: 'WEEKLY_SUMMARY',
        scheduledTime: etTime.date,
        completed: true,
        tweetId: result?.id,
        content,
      });

      logger.info({ tweetId: result?.id }, '[ScheduledPosts] Weekly summary posted');
      return result?.id || null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] Failed to post weekly summary');
      return null;
    }
  }

  private async generateWeeklySummaryContent(stats: WeeklyStats | null): Promise<string | null> {
    if (!this.runtime) return null;

    const etTime = getCurrentETTime();

    if (!stats || stats.closedTrades === 0) {
      return `Weekly Summary (${etTime.dateStr})

No trades closed this week. Markets were quiet or positions are still open.

Next week: watching for catalyst events and mispriced markets.`.slice(0, 280);
    }

    const prompt = `You are Zeracle, a professional prediction market analyst. Generate a weekly performance summary tweet.

WEEKLY PERFORMANCE (${stats.weekStart} to ${stats.weekEnd}):
- Trades Closed: ${stats.closedTrades}
- Win Rate: ${stats.winRate.toFixed(0)}% (${stats.winCount}W / ${stats.lossCount}L)
- Net P&L: $${stats.totalPnl.toFixed(2)}
- Average Position: $${stats.avgTradeSize.toFixed(2)}
${stats.bestTrade ? `- Top Winner: "${stats.bestTrade.marketQuestion.slice(0, 40)}..." (+$${stats.bestTrade.pnl?.toFixed(2)})` : ''}
${stats.worstTrade && stats.worstTrade.pnl && stats.worstTrade.pnl < 0 ? `- Largest Loss: "${stats.worstTrade.marketQuestion.slice(0, 40)}..." ($${stats.worstTrade.pnl.toFixed(2)})` : ''}

Write a professional tweet (max 280 chars) that:
1. Reports performance metrics objectively
2. Notes one key insight or lesson
3. Uses professional, analytical tone - NO hashtags, NO emojis

IMPORTANT: No emojis. No hashtags. Be transparent about both wins and losses.
Return ONLY the tweet text.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      if (typeof response === 'string') {
        // Remove any emojis, hashtags, and action tags that might slip through
        const cleaned = response
          // CRITICAL: Remove leaked action tags
          .replace(/<actions>[\s\S]*?<\/actions>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
          .replace(/[\u{2600}-\u{27BF}]/gu, '')
          .replace(/#\w+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return cleaned.slice(0, 280);
      }
      return null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] LLM failed for weekly summary');

      // Fallback
      const pnlSign = stats.totalPnl >= 0 ? '+' : '';
      return `Weekly Performance Review

Trades: ${stats.closedTrades} closed
Win Rate: ${stats.winRate.toFixed(0)}% (${stats.winCount}W/${stats.lossCount}L)
P&L: ${pnlSign}$${stats.totalPnl.toFixed(2)}

${stats.lessonsLearned[0] || 'Discipline over conviction.'}`.slice(0, 280);
    }
  }

  // ============= Manual Triggers =============

  /**
   * Force a market update (for testing or manual trigger)
   */
  async forceMarketUpdate(): Promise<string | null> {
    return this.postMarketUpdate();
  }

  /**
   * Force a daily update (for testing or manual trigger)
   */
  async forceDailyUpdate(): Promise<string | null> {
    return this.postDailyUpdate();
  }

  /**
   * Force a weekly summary (for testing or manual trigger)
   */
  async forceWeeklySummary(): Promise<string | null> {
    return this.postWeeklySummary();
  }

  // ============= Public Getters =============

  getScheduledPosts(): ScheduledPost[] {
    return Array.from(this.scheduledPosts.values());
  }

  getRecentPosts(limit: number = 10): ScheduledPost[] {
    return Array.from(this.scheduledPosts.values())
      .filter((p) => p.completed)
      .sort((a, b) => b.scheduledTime.getTime() - a.scheduledTime.getTime())
      .slice(0, limit);
  }
}
