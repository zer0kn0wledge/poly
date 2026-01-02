/**
 * POST_ANALYSIS Action
 *
 * Allows on-demand Twitter posting of market analysis.
 * Users can trigger analysis tweets for specific markets,
 * categories, or general market updates via the web UI.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger, ModelType } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';
import { TwitterService } from '../services/twitter';
import { ScheduledPostsService } from '../services/scheduled-posts';
import { DataSourcesService } from '../services/data-sources';
import { MarketIntelligenceService } from '../services/market-intelligence';
import { getCurrentETTime } from '../providers/timezone';
import type { PolymarketMarket } from '../types';

/**
 * Sanitize text - remove emojis and hashtags.
 */
function sanitizeText(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
    .replace(/#\w+/g, '') // Remove hashtags
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

// Post types
type PostType = 'market' | 'category' | 'update' | 'daily' | 'weekly' | 'custom';

/**
 * Detect post type from user message
 */
function detectPostType(text: string): { type: PostType; target?: string } {
  const lowerText = text.toLowerCase();

  // Check for daily/weekly triggers
  if (lowerText.includes('daily') && (lowerText.includes('update') || lowerText.includes('post'))) {
    return { type: 'daily' };
  }
  if (lowerText.includes('weekly') && (lowerText.includes('summary') || lowerText.includes('post'))) {
    return { type: 'weekly' };
  }

  // Check for market update
  if (lowerText.includes('market update') || lowerText.includes('update post')) {
    return { type: 'update' };
  }

  // Check for category post
  const categories = ['crypto', 'politics', 'sports', 'tech', 'finance', 'world'];
  for (const cat of categories) {
    if (lowerText.includes(cat)) {
      return { type: 'category', target: cat };
    }
  }

  // Check for specific market post
  const quotedMatch = text.match(/"([^"]+)"/);
  if (quotedMatch) {
    return { type: 'market', target: quotedMatch[1] };
  }

  // Try to extract market from "post about X"
  const postAboutMatch = lowerText.match(/(?:post|tweet)(?:\s+about)?\s+(.+?)(?:\s+on\s+twitter|\s+market|$)/i);
  if (postAboutMatch) {
    return { type: 'market', target: postAboutMatch[1].trim() };
  }

  // Default to general update
  return { type: 'update' };
}

export const postAnalysisAction: Action = {
  name: 'POST_ANALYSIS',
  similes: [
    // Direct posting commands
    'POST_TO_TWITTER',
    'TWEET_ANALYSIS',
    'SHARE_ANALYSIS',
    'TWITTER_UPDATE',
    'POST_UPDATE',
    'TWEET_MARKETS',
    // Alternative phrasings
    'SEND_TWEET',
    'PUBLISH_TWEET',
    'TWITTER_POST',
    'MAKE_TWEET',
    'WRITE_TWEET',
    // Analysis sharing
    'SHARE_ON_TWITTER',
    'POST_MARKET_UPDATE',
    'TWEET_UPDATE',
    'SHARE_MARKETS',
    // General posting capabilities
    'CAN_YOU_TWEET',
    'CAN_YOU_POST',
    'POST_SOMETHING',
    'TWEET_SOMETHING',
    'SHARE_SOMETHING',
  ],
  description: 'Post market analysis or updates to Twitter on demand',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    // AGGRESSIVE: Any mention of twitter/tweet/post should trigger this action
    // This is the PRIMARY action for all Twitter posting - be liberal in matching
    const twitterTriggers = [
      'tweet', 'twitter', 'post this', 'share this', 'post it',
      'share it', 'put this on', 'send to twitter', 'post on x',
      'share on x', 'post analysis', 'tweet analysis', 'x.com',
      'can you tweet', 'can you post', 'please tweet', 'please post',
      'would you tweet', 'could you post', 'make a tweet', 'send tweet',
      'publish', 'post to', 'share to', 'tweet about', 'post about'
    ];

    const shouldTrigger = twitterTriggers.some((t) => text.includes(t));

    if (shouldTrigger) {
      logger.info('[POST_ANALYSIS] Validation PASSED - twitter request detected', { text: text.slice(0, 50) });
    }

    return shouldTrigger;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown>,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      const twitterService = runtime.getService<TwitterService>('twitter');
      const scheduledPostsService = runtime.getService<ScheduledPostsService>('scheduled-posts');
      const polymarketService = runtime.getService<PolymarketService>('polymarket');
      const dataSourcesService = runtime.getService<DataSourcesService>('data-sources');
      const intelligenceService = runtime.getService<MarketIntelligenceService>('market-intelligence');

      if (!twitterService?.isAvailable()) {
        const errorMsg = 'Twitter service not available. Please check Twitter API credentials.';
        if (callback) await callback({ text: errorMsg, error: true });
        return { success: false, error: errorMsg };
      }

      const text = message.content.text || '';
      const { type, target } = detectPostType(text);
      const etTime = getCurrentETTime();

      logger.info({ type, target }, '[POST_ANALYSIS] Processing post request');

      if (callback) {
        await callback({ text: `Preparing ${type} post${target ? ` for "${target}"` : ''}...` });
      }

      let tweetContent: string | null = null;
      let tweetResult: { id: string; url: string } | null = null;

      switch (type) {
        case 'daily':
          if (scheduledPostsService) {
            const result = await scheduledPostsService.forceDailyUpdate();
            if (result) {
              tweetResult = { id: result, url: `https://twitter.com/i/status/${result}` };
            }
          }
          break;

        case 'weekly':
          if (scheduledPostsService) {
            const result = await scheduledPostsService.forceWeeklySummary();
            if (result) {
              tweetResult = { id: result, url: `https://twitter.com/i/status/${result}` };
            }
          }
          break;

        case 'update':
          if (scheduledPostsService) {
            const result = await scheduledPostsService.forceMarketUpdate();
            if (result) {
              tweetResult = { id: result, url: `https://twitter.com/i/status/${result}` };
            }
          }
          break;

        case 'category':
          if (target && polymarketService) {
            tweetContent = await generateCategoryTweet(
              runtime,
              polymarketService,
              dataSourcesService,
              target,
              etTime
            );
          }
          break;

        case 'market':
          if (target && polymarketService) {
            tweetContent = await generateMarketTweet(
              runtime,
              polymarketService,
              intelligenceService,
              target,
              etTime
            );
          }
          break;

        default:
          if (scheduledPostsService) {
            const result = await scheduledPostsService.forceMarketUpdate();
            if (result) {
              tweetResult = { id: result, url: `https://twitter.com/i/status/${result}` };
            }
          }
      }

      // Post custom content if generated
      if (tweetContent && !tweetResult) {
        const result = await twitterService.tweet(tweetContent);
        if (result) {
          tweetResult = { id: result.id, url: result.url };
        }
      }

      if (tweetResult) {
        const successMsg = `Posted to Twitter successfully.\n\nTweet ID: ${tweetResult.id}\nURL: ${tweetResult.url}`;
        if (callback) {
          await callback({
            text: successMsg,
            action: 'POST_ANALYSIS',
          });
        }
        return {
          success: true,
          text: successMsg,
          data: { tweetId: tweetResult.id, url: tweetResult.url },
        };
      } else {
        const errorMsg = 'Failed to post to Twitter. Please try again.';
        if (callback) await callback({ text: errorMsg, error: true });
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      const errorMsg = `Post failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[POST_ANALYSIS] Error');

      if (callback) {
        await callback({ text: errorMsg, error: true });
      }

      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMsg),
      };
    }
  },

  examples: [
    [
      {
        name: '{{userName}}',
        content: { text: 'Post a market update to Twitter' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Posted to Twitter successfully.\n\nTweet ID: 1234567890\nURL: https://twitter.com/i/status/1234567890',
          action: 'POST_ANALYSIS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: { text: 'Tweet about the crypto markets' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Posted to Twitter successfully.\n\nTweet ID: 1234567891\nURL: https://twitter.com/i/status/1234567891',
          action: 'POST_ANALYSIS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: { text: 'Post the daily update now' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Posted to Twitter successfully.\n\nTweet ID: 1234567892\nURL: https://twitter.com/i/status/1234567892',
          action: 'POST_ANALYSIS',
        },
      },
    ],
  ],
};

/**
 * Generate tweet for a specific category
 */
async function generateCategoryTweet(
  runtime: IAgentRuntime,
  polymarketService: PolymarketService,
  dataSourcesService: DataSourcesService | null,
  category: string,
  etTime: ReturnType<typeof getCurrentETTime>
): Promise<string | null> {
  try {
    const markets = await polymarketService.getMarketsByCategory(category, 10);
    if (markets.length === 0) return null;

    // Get top 3 by volume
    const topMarkets = markets
      .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
      .slice(0, 3);

    // Get news context
    let newsContext = '';
    if (dataSourcesService) {
      const validCategories = ['politics', 'crypto', 'sports', 'economy', 'tech', 'geopolitics'] as const;
      type NewsCategory = typeof validCategories[number];
      const newsCategory = validCategories.includes(category as NewsCategory) ? category as NewsCategory : 'politics';
      const news = await dataSourcesService.getNewsByCategory(newsCategory);
      newsContext = news.slice(0, 5).map((n) => `- ${n.title}`).join('\n');
    }

    const marketsText = topMarkets.map((m, i) => {
      const yesPrice = m.tokens.find((t) => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
      const vol = m.volume_num >= 1000000
        ? `$${(m.volume_num / 1000000).toFixed(1)}M`
        : `$${((m.volume_num || 0) / 1000).toFixed(0)}K`;
      return `${i + 1}. "${m.question.slice(0, 60)}" - ${(yesPrice * 100).toFixed(0)}% (${vol})`;
    }).join('\n');

    const prompt = `Generate a professional tweet about ${category.toUpperCase()} prediction markets.

Time: ${etTime.dateStr} ${etTime.timeStr} ET

MARKETS:
${marketsText}

${newsContext ? `NEWS:\n${newsContext}` : ''}

Write a professional tweet (max 280 chars) that:
1. Highlights 1-2 key markets with odds
2. Provides brief analytical insight
3. Professional tone - no emojis, no hashtags

Return ONLY the tweet text.`;

    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

    if (typeof response === 'string') {
      return sanitizeText(response).slice(0, 280);
    }
    return null;
  } catch (error) {
    logger.error({ error, category }, '[POST_ANALYSIS] Category tweet generation failed');
    return null;
  }
}

/**
 * Generate tweet for a specific market
 */
async function generateMarketTweet(
  runtime: IAgentRuntime,
  polymarketService: PolymarketService,
  intelligenceService: MarketIntelligenceService | null,
  marketQuery: string,
  etTime: ReturnType<typeof getCurrentETTime>
): Promise<string | null> {
  try {
    const markets = await polymarketService.searchMarkets(marketQuery, 1);
    if (markets.length === 0) return null;

    const market = markets[0];
    const yesToken = market.tokens.find((t) => t.outcome.toLowerCase() === 'yes');
    const yesPrice = yesToken?.price || 0.5;

    // Get opportunity data if available
    let opportunityContext = '';
    if (intelligenceService) {
      const opportunities = intelligenceService.getOpportunities();
      const opp = opportunities.find((o) => o.market.condition_id === market.condition_id);
      if (opp) {
        opportunityContext = `\nOpportunity Score: ${opp.score}/100 | Direction: ${opp.direction}`;
      }
    }

    const vol = market.volume_num >= 1000000
      ? `$${(market.volume_num / 1000000).toFixed(1)}M`
      : `$${((market.volume_num || 0) / 1000).toFixed(0)}K`;

    const prompt = `Generate a professional tweet about this prediction market.

MARKET: "${market.question}"
YES Price: ${(yesPrice * 100).toFixed(0)}%
Volume: ${vol}
${opportunityContext}

Time: ${etTime.dateStr} ${etTime.timeStr} ET

Write a professional tweet (max 280 chars) that:
1. States the market and current odds
2. Provides brief analytical context
3. Professional tone - no emojis, no hashtags, no exclamation marks

Return ONLY the tweet text.`;

    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

    if (typeof response === 'string') {
      return sanitizeText(response).slice(0, 280);
    }
    return null;
  } catch (error) {
    logger.error({ error, marketQuery }, '[POST_ANALYSIS] Market tweet generation failed');
    return null;
  }
}

export default postAnalysisAction;
