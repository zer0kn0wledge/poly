/**
 * Scheduled Posts Service
 *
 * Handles scheduled Twitter posts:
 * - Daily Polymarket Update: Posted every morning with top markets by volume
 * - Weekly Trade Summary: Posted every Friday at 6pm ET with performance analysis
 */

import { Service, logger, type IAgentRuntime, ModelType } from '@elizaos/core';
import { getCurrentETTime, getRelativeTimeContext, isMarketExpired, detectPastYearMarket } from '../providers/timezone';
import { PolymarketService } from './polymarket';
import { TwitterService } from './twitter';
import { StrategyLearningService, type WeeklyStats } from './strategy-learning';
import { DataSourcesService } from './data-sources';
import type { PolymarketMarket } from '../types';

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

    // Also do an immediate check
    logger.info('[ScheduledPosts] Running immediate check on startup');
    await this.checkAndExecuteScheduledPosts();
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

  // ============= 2-Hour Market Update =============

  /**
   * Post a market update every 2 hours with top markets and analysis
   */
  async postMarketUpdate(): Promise<string | null> {
    if (!this.runtime) return null;

    const etTime = getCurrentETTime();
    logger.info('[ScheduledPosts] Generating 2-hour market update', { hour: etTime.hour, date: etTime.dateStr });

    const polymarketService = this.runtime.getService<PolymarketService>('polymarket');
    const twitterService = this.runtime.getService<TwitterService>('twitter');

    if (!polymarketService || !twitterService?.isAvailable()) {
      logger.warn('[ScheduledPosts] Required services not available for market update');
      return null;
    }

    try {
      // Get trending markets by volume
      const markets = await polymarketService.getTrendingMarkets({
        minVolume: 10000,
        limit: 20,
        sortBy: 'volume',
      });

      if (markets.length === 0) {
        logger.warn('[ScheduledPosts] No markets for 2-hour update');
        return null;
      }

      // Select top markets for this update
      const topMarkets = markets.slice(0, 3);

      // Generate update content
      const content = await this.generateMarketUpdateContent(topMarkets, etTime);

      if (!content) {
        logger.warn('[ScheduledPosts] Failed to generate market update content');
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

      logger.info({ tweetId: result?.id, hour: etTime.hour }, '[ScheduledPosts] Market update posted');
      return result?.id || null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] Failed to post market update');
      return null;
    }
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

    const prompt = `You are Zeracle, a sharp prediction market analyst. Generate a market update tweet.

Time: ${etTime.timeStr} ET

TOP MARKETS:
${marketsText}

Write a professional tweet (max 280 chars) that:
1. Opens with a brief market observation or insight
2. Highlights 1-2 interesting odds or movements
3. Provides your analytical take (not just data)
4. Uses professional tone - no emojis, no hashtags, no excessive punctuation

Keep it sharp, analytical, and data-driven. Sound like a professional analyst, not a social media influencer.
Return ONLY the tweet text.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      if (typeof response === 'string') {
        // Remove any emojis and hashtags that might slip through
        const cleaned = response
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

    const prompt = `You are Zeracle, a professional prediction market analyst. Generate a daily market briefing tweet.

Date: ${etTime.dayOfWeek}, ${etTime.dateStr}

TOP MARKETS BY VOLUME:
${marketsText}

RELEVANT NEWS:
${newsContext || 'No significant news.'}

Write a professional tweet (max 280 chars) that:
1. Highlights 2-3 key markets with current odds
2. Provides analytical insight on pricing
3. Notes any significant volume patterns
4. Uses professional, authoritative tone - NO hashtags, NO emojis

IMPORTANT: No emojis. No hashtags. No exclamation marks. No slang.
Sound like a Bloomberg analyst, not a Twitter influencer.
Return ONLY the tweet text.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      if (typeof response === 'string') {
        // Remove any emojis and hashtags that might slip through
        const cleaned = response
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
        // Remove any emojis and hashtags that might slip through
        const cleaned = response
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
