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
  type: 'DAILY_UPDATE' | 'WEEKLY_SUMMARY';
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

  private readonly DAILY_UPDATE_HOUR = 9; // 9 AM ET
  private readonly WEEKLY_SUMMARY_HOUR = 18; // 6 PM ET
  private readonly WEEKLY_SUMMARY_DAY = 5; // Friday (0 = Sunday)

  constructor() {
    super();
  }

  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[ScheduledPosts] Initializing scheduled posts service');
    this.runtime = runtime;

    // Start checking for scheduled posts every minute
    this.checkInterval = setInterval(() => {
      this.checkAndExecuteScheduledPosts().catch((error) => {
        logger.error({ error }, '[ScheduledPosts] Error checking scheduled posts');
      });
    }, 60 * 1000); // Check every minute

    // Also do an immediate check
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

    // Check for daily update (9 AM ET on weekdays)
    if (
      etTime.hour === this.DAILY_UPDATE_HOUR &&
      !etTime.isWeekend &&
      !this.hasPostedToday('DAILY_UPDATE', etTime.dateStr)
    ) {
      await this.postDailyUpdate();
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

    const prompt = `You are Zeracle, a female prediction market analyst. Generate a concise daily market update tweet.

Current Date: ${etTime.dayOfWeek}, ${etTime.dateStr} (${etTime.timeStr} ET)

TOP MARKETS BY VOLUME:
${marketsText}

RECENT NEWS:
${newsContext || 'No significant news.'}

Write a tweet (max 280 chars) that:
1. Highlights 2-3 most interesting markets
2. Provides brief assessment of current odds
3. Mentions any notable volume or price movements
4. Uses your analytical, degen voice (she/her pronouns ok but not required in every tweet)
5. Ends with relevant hashtags

Keep it punchy and data-driven. No emojis unless absolutely necessary.
Return ONLY the tweet text, nothing else.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      if (typeof response === 'string') {
        // Ensure it fits in a tweet
        return response.slice(0, 280);
      }
      return null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] LLM failed for daily update');

      // Fallback: generate simple update
      const top3 = markets.slice(0, 3);
      const fallback = `Daily Polymarket Update (${etTime.dateStr})

Top markets:
${top3.map((m, i) => {
  const yesPrice = m.tokens.find((t) => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
  return `${i + 1}. ${m.question.slice(0, 50)}... - ${(yesPrice * 100).toFixed(0)}%`;
}).join('\n')}

#Polymarket #PredictionMarkets`;

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
      return `Weekly Trade Summary (${etTime.dateStr})

No trades closed this week. Markets were quiet or i was accumulating positions.

Next week: watching for catalyst events and mispriced markets.

#Polymarket #WeeklyUpdate`.slice(0, 280);
    }

    const prompt = `You are Zeracle, a female prediction market trader. Generate a weekly trade summary tweet.

WEEKLY STATS (${stats.weekStart} to ${stats.weekEnd}):
- Total Trades: ${stats.totalTrades}
- Closed: ${stats.closedTrades}
- Win/Loss: ${stats.winCount}W / ${stats.lossCount}L (${stats.winRate.toFixed(0)}% win rate)
- Total P&L: $${stats.totalPnl.toFixed(2)}
- Avg Trade Size: $${stats.avgTradeSize.toFixed(2)}
${stats.bestTrade ? `- Best Trade: "${stats.bestTrade.marketQuestion.slice(0, 40)}..." (+$${stats.bestTrade.pnl?.toFixed(2)})` : ''}
${stats.worstTrade && stats.worstTrade.pnl && stats.worstTrade.pnl < 0 ? `- Worst Trade: "${stats.worstTrade.marketQuestion.slice(0, 40)}..." ($${stats.worstTrade.pnl.toFixed(2)})` : ''}

TOP DATA SOURCES:
${stats.topDataSources.slice(0, 3).map((s) => `- ${s.source}: ${s.winRate.toFixed(0)}% accuracy`).join('\n')}

LESSONS LEARNED:
${stats.lessonsLearned.join('\n')}

Write a tweet (max 280 chars) that:
1. Summarizes the week's performance honestly
2. Highlights key wins and losses
3. Shares one lesson learned
4. Uses your analytical, transparent voice
5. Ends with #Polymarket #WeeklyUpdate

Be honest about losses. Return ONLY the tweet text.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      if (typeof response === 'string') {
        return response.slice(0, 280);
      }
      return null;
    } catch (error) {
      logger.error({ error }, '[ScheduledPosts] LLM failed for weekly summary');

      // Fallback
      const pnlSign = stats.totalPnl >= 0 ? '+' : '';
      return `Weekly Trade Summary

${stats.closedTrades} trades closed
${stats.winRate.toFixed(0)}% win rate (${stats.winCount}W/${stats.lossCount}L)
P&L: ${pnlSign}$${stats.totalPnl.toFixed(2)}

${stats.lessonsLearned[0] || 'Process over outcomes.'}

#Polymarket #WeeklyUpdate`.slice(0, 280);
    }
  }

  // ============= Manual Triggers =============

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
