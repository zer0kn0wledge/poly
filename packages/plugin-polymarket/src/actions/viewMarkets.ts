/**
 * View Markets Action
 *
 * Allows users to search and browse prediction markets.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { ModelType, generateObject, logger } from '@elizaos/core';
import { z } from 'zod';
import { PolymarketService } from '../services/polymarket';

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

const searchParamsSchema = z.object({
  query: z.string().optional().describe('Search query for markets'),
  category: z.string().optional().describe('Category filter (politics, sports, crypto, etc.)'),
  limit: z.number().min(1).max(20).default(5).describe('Number of results'),
});

type SearchParams = z.infer<typeof searchParamsSchema>;

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

      // Extract search parameters
      const text = message.content.text || '';

      // Simple extraction - look for quoted strings or key phrases
      let query = '';
      const quotedMatch = text.match(/"([^"]+)"/);
      if (quotedMatch) {
        query = quotedMatch[1];
      } else {
        // Extract keywords after "about", "for", "on", etc.
        const aboutMatch = text.match(/(?:about|for|on|regarding)\s+(.+?)(?:\?|$)/i);
        if (aboutMatch) {
          query = aboutMatch[1].trim();
        }
      }

      // Determine limit
      const limitMatch = text.match(/(\d+)\s*(?:markets?|results?)/i);
      const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 20) : 5;

      logger.info({ query, limit }, '[ViewMarketsAction] Fetching markets');

      // Fetch markets
      const markets = query
        ? await service.searchMarkets(query, limit)
        : await service.getMarkets({ active: true, limit });

      if (markets.length === 0) {
        const noResultsMsg = query
          ? `No markets found for "${query}". Try a different search term.`
          : 'No active markets found.';
        if (callback) {
          await callback({ text: noResultsMsg });
        }
        return { success: true, text: noResultsMsg, data: { markets: [] } };
      }

      // Format market list - single-line format to prevent DB issues with newlines
      const marketList = markets.slice(0, 5).map((m, i) => {
        const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
        const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
        const yesPrice = yesToken?.price ?? 0.5;
        const noPrice = noToken?.price ?? 0.5;
        const question = sanitizeText(m.question).slice(0, 60);

        return `${i + 1}. ${question} - Yes: ${(yesPrice * 100).toFixed(0)}%, No: ${(noPrice * 100).toFixed(0)}%`;
      }).join(' | ');

      const responseText = `Markets${query ? ` for "${sanitizeText(query)}"` : ''}: ${marketList}`;

      logger.info({ marketCount: markets.length, responsePreview: responseText.slice(0, 100) }, '[ViewMarketsAction] Sending response');

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
          markets: markets.map(m => ({
            conditionId: m.condition_id,
            question: m.question,
            tokens: m.tokens,
            volume: m.volume_num,
            active: m.active,
          })),
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
          text: 'Markets for "crypto": 1. Will Bitcoin reach $100k in 2025? - Yes: 65%, No: 35% | 2. ETH above $5k? - Yes: 40%, No: 60%',
          action: 'VIEW_MARKETS',
        },
      },
    ],
  ],
};
