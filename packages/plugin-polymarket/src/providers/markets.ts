/**
 * Markets Provider
 *
 * Provides context about trending and relevant markets.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';

export const marketsProvider: Provider = {
  name: 'POLYMARKET_MARKETS',
  description: 'Provides information about trending and active prediction markets',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    try {
      const service = runtime.getService<PolymarketService>('polymarket');

      if (!service) {
        return {
          text: '',
          values: {},
          data: {},
        };
      }

      // Get top markets by volume
      const markets = await service.getMarkets({ active: true, limit: 10 });

      if (markets.length === 0) {
        return {
          text: 'No active markets available.',
          values: { marketCount: 0 },
          data: { markets: [] },
        };
      }

      // Sort by volume
      const sortedMarkets = [...markets].sort((a, b) => b.volume_num - a.volume_num);

      const marketSummary = sortedMarkets.slice(0, 5).map((m, i) => {
        const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
        const yesPrice = yesToken?.price ?? 0.5;
        return `${i + 1}. ${m.question} - Yes: ${(yesPrice * 100).toFixed(0)}% (Vol: $${(m.volume_num / 1000).toFixed(0)}k)`;
      }).join('\n');

      const contextText = `
**Top Polymarket Predictions:**
${marketSummary}
`.trim();

      return {
        text: contextText,
        values: {
          marketCount: markets.length,
          topMarketQuestion: sortedMarkets[0]?.question,
          topMarketYesPrice: sortedMarkets[0]?.tokens.find(t => t.outcome.toLowerCase() === 'yes')?.price,
        },
        data: {
          markets: sortedMarkets.slice(0, 5).map(m => ({
            conditionId: m.condition_id,
            question: m.question,
            yesPrice: m.tokens.find(t => t.outcome.toLowerCase() === 'yes')?.price,
            volume: m.volume_num,
          })),
        },
      };
    } catch (error) {
      logger.error({ error }, '[MarketsProvider] Error fetching markets');
      return {
        text: '',
        values: {},
        data: {},
      };
    }
  },
};
