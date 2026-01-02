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

      if (callback) {
        await callback({
          text: query
            ? `Searching for markets about "${query}"...`
            : 'Fetching active markets...',
        });
      }

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

      // Format market list - keep it simple, no emojis (can cause DB encoding issues)
      const marketList = markets.slice(0, 5).map((m, i) => {
        const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
        const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
        const yesPrice = yesToken?.price ?? 0.5;
        const noPrice = noToken?.price ?? 0.5;

        return `${i + 1}. ${m.question}
   Yes: ${(yesPrice * 100).toFixed(1)}% | No: ${(noPrice * 100).toFixed(1)}%
   Volume: $${Math.round(m.volume_num).toLocaleString()}`;
      }).join('\n\n');

      const responseText = `Markets${query ? ` matching "${query}"` : ''}:\n\n${marketList}`;

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
          text: 'Markets matching "crypto":\n\n1. Will Bitcoin reach $100k in 2025?\n   Yes: 65.2% | No: 34.8%\n   Volume: $1,234,567',
          action: 'VIEW_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'What political markets are available?',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Markets matching "political":\n\n1. Who will win the 2024 election?\n   Yes: 52.1% | No: 47.9%\n   Volume: $5,678,901',
          action: 'VIEW_MARKETS',
        },
      },
    ],
  ],
};
