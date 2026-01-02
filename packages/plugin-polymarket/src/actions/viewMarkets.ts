/**
 * View Markets Action
 *
 * Allows users to search and browse prediction markets with detailed analysis.
 * Supports category-based filtering and provides comprehensive market data.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';
import type { PolymarketMarket } from '../types';

/**
 * Sanitize text to prevent database encoding issues.
 * Removes emojis and non-ASCII characters.
 */
function sanitizeText(text: string): string {
  if (!text) return '';
  // Remove emojis and other non-ASCII characters, keep basic punctuation
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // emoticons
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // misc symbols
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // transport
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // flags
    .replace(/[\u{2600}-\u{26FF}]/gu, '')   // misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, '')   // dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // variation selectors
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // supplemental symbols
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '') // chess symbols
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '') // symbols extended
    .replace(/[^\x00-\x7F]/g, '')           // remove any remaining non-ASCII
    .trim();
}

/**
 * Category keywords for detection
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  crypto: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'defi', 'blockchain', 'token', 'coin', 'web3'],
  sports: ['sports', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'super bowl', 'championship', 'game', 'match', 'finals', 'world cup'],
  politics: ['politics', 'election', 'president', 'trump', 'biden', 'congress', 'senate', 'vote', 'political', 'democrat', 'republican', 'governor'],
  finance: ['finance', 'fed', 'interest rate', 'inflation', 'stock', 'economy', 'gdp', 'recession', 'market crash'],
  tech: ['tech', 'technology', 'ai', 'apple', 'google', 'microsoft', 'meta', 'openai', 'tesla', 'elon'],
  entertainment: ['entertainment', 'oscar', 'grammy', 'movie', 'tv', 'celebrity', 'music', 'award', 'emmy'],
  world: ['world', 'ukraine', 'russia', 'china', 'war', 'international', 'treaty', 'conflict', 'geopolitical'],
};

/**
 * Detect category from user text
 */
function detectCategory(text: string): string | null {
  const lowerText = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return category;
      }
    }
  }
  return null;
}

/**
 * Format volume for display
 */
function formatVolume(volume: number): string {
  if (volume >= 1000000) return `$${(volume / 1000000).toFixed(1)}M`;
  if (volume >= 1000) return `$${(volume / 1000).toFixed(0)}K`;
  return `$${volume.toFixed(0)}`;
}

/**
 * Format time remaining until market end date
 */
function formatTimeRemaining(endDateIso: string): string {
  if (!endDateIso) return 'ongoing';
  const endDate = new Date(endDateIso);
  const now = new Date();
  const hoursRemaining = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursRemaining < 0) return 'awaiting resolution';
  if (hoursRemaining < 1) return '<1 hour';
  if (hoursRemaining < 24) return `${Math.round(hoursRemaining)}h`;
  if (hoursRemaining < 168) return `${Math.round(hoursRemaining / 24)}d`;
  return `${Math.round(hoursRemaining / 168)}w`;
}

/**
 * Format a single market with detailed data
 */
function formatMarketDetailed(m: PolymarketMarket, index: number): string {
  const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
  const yesPrice = yesToken?.price ?? 0.5;
  const noPrice = noToken?.price ?? 0.5;
  const question = sanitizeText(m.question).slice(0, 80);
  const volume = formatVolume(m.volume_num || 0);
  const liquidity = formatVolume(m.liquidity || 0);
  const timeLeft = formatTimeRemaining(m.end_date_iso);

  return `${index}. ${question} | YES: ${(yesPrice * 100).toFixed(0)}% / NO: ${(noPrice * 100).toFixed(0)}% | Vol: ${volume} | Liq: ${liquidity} | Ends: ${timeLeft}`;
}

export const viewMarketsAction: Action = {
  name: 'VIEW_MARKETS',
  similes: [
    'SEARCH_MARKETS',
    'LIST_MARKETS',
    'FIND_MARKETS',
    'SHOW_MARKETS',
    'GET_MARKETS',
    'BROWSE_MARKETS',
  ],
  description: 'Search and view prediction markets on Polymarket',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    const viewKeywords = ['show', 'list', 'find', 'search', 'browse', 'view', 'what', 'which'];
    const marketKeywords = ['market', 'markets', 'prediction', 'polymarket', 'betting', 'odds'];

    const hasViewIntent = viewKeywords.some(k => text.includes(k));
    const hasMarketContext = marketKeywords.some(k => text.includes(k));

    return hasViewIntent && hasMarketContext;
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
      const service = runtime.getService<PolymarketService>('polymarket');
      if (!service) {
        const errorMsg = 'Polymarket service not available.';
        if (callback) {
          await callback({ text: errorMsg, error: true });
        }
        return { success: false, error: errorMsg };
      }

      // Extract search parameters from user text
      const text = message.content.text || '';

      // Detect category from user text
      const detectedCategory = detectCategory(text);

      // Extract specific query if quoted or after keywords
      let specificQuery = '';
      const quotedMatch = text.match(/"([^"]+)"/);
      if (quotedMatch) {
        specificQuery = quotedMatch[1];
      } else {
        // Extract keywords after "about", "for", "on", etc.
        const aboutMatch = text.match(/(?:about|for|on|regarding)\s+(.+?)(?:\?|$)/i);
        if (aboutMatch) {
          specificQuery = aboutMatch[1].trim();
        }
      }

      // Determine limit
      const limitMatch = text.match(/(\d+)\s*(?:markets?|results?)/i);
      const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 10) : 5;

      logger.info({ detectedCategory, specificQuery, limit }, '[ViewMarketsAction] Fetching markets');

      // Fetch markets based on detected category or query
      let markets: PolymarketMarket[] = [];
      let searchContext = '';

      if (detectedCategory) {
        // Use category-based search for better filtering
        markets = await service.getMarketsByCategory(detectedCategory, limit * 2);
        searchContext = `${detectedCategory.toUpperCase()} markets`;
        logger.info({ category: detectedCategory, count: markets.length }, '[ViewMarketsAction] Category search');
      } else if (specificQuery) {
        // Use specific query search
        markets = await service.searchMarkets(specificQuery, limit * 2);
        searchContext = `markets for "${sanitizeText(specificQuery)}"`;
      } else {
        // Get trending/high-volume markets
        markets = await service.getTrendingMarkets({ limit: limit * 2, minVolume: 5000 });
        searchContext = 'trending markets';
      }

      // Sort by volume and take top results
      markets = markets
        .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
        .slice(0, limit);

      if (markets.length === 0) {
        const noResultsMsg = detectedCategory
          ? `No active ${detectedCategory} markets found right now. Try a different category.`
          : specificQuery
            ? `No markets found for "${sanitizeText(specificQuery)}". Try different search terms.`
            : 'No active markets found at the moment.';
        if (callback) {
          await callback({ text: noResultsMsg });
        }
        return { success: true, text: noResultsMsg, data: { markets: [] } };
      }

      // Format markets with detailed data
      const formattedMarkets = markets.map((m, i) => formatMarketDetailed(m, i + 1));

      // Calculate aggregate stats
      const totalVolume = markets.reduce((sum, m) => sum + (m.volume_num || 0), 0);
      const avgLiquidity = markets.reduce((sum, m) => sum + (m.liquidity || 0), 0) / markets.length;

      // Build comprehensive response
      const header = `Top ${searchContext} (${markets.length} results, total vol: ${formatVolume(totalVolume)}):`;
      const responseText = `${header} ${formattedMarkets.join(' | ')}`;

      logger.info({
        category: detectedCategory,
        query: specificQuery,
        marketCount: markets.length,
        totalVolume,
      }, '[ViewMarketsAction] Sending response');

      if (callback) {
        await callback({
          text: responseText,
          action: 'VIEW_MARKETS',
        });
      }

      return {
        success: true,
        text: responseText,
        data: {
          category: detectedCategory,
          query: specificQuery,
          markets: markets.map(m => ({
            conditionId: m.condition_id,
            question: m.question,
            tokens: m.tokens,
            volume: m.volume_num,
            liquidity: m.liquidity,
            spread: m.spread,
            endDate: m.end_date_iso,
            active: m.active,
          })),
          stats: {
            totalVolume,
            avgLiquidity,
            marketCount: markets.length,
          },
        },
      };
    } catch (error) {
      const errorMsg = `Failed to fetch markets: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[ViewMarketsAction] Error');

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
        content: {
          text: 'Show me prediction markets about crypto',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Top CRYPTO markets (5 results, total vol: $12.5M): 1. Will Bitcoin reach $100k in 2025? | YES: 65% / NO: 35% | Vol: $5.2M | Liq: $850K | Ends: 12d | 2. ETH above $5k by year end? | YES: 42% / NO: 58% | Vol: $3.1M | Liq: $420K | Ends: 25d',
          action: 'VIEW_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'What sports markets are hot right now?',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Top SPORTS markets (5 results, total vol: $8.7M): 1. Super Bowl 2025 winner? | YES: 28% / NO: 72% | Vol: $4.5M | Liq: $1.2M | Ends: 35d | 2. NBA Finals champion? | YES: 45% / NO: 55% | Vol: $2.1M | Liq: $380K | Ends: 180d',
          action: 'VIEW_MARKETS',
        },
      },
    ],
  ],
};
