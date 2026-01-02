/**
 * Sell Outcome Action
 *
 * Allows the agent to sell shares of a prediction market outcome.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { ModelType, logger } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';

/**
 * Sanitize text to prevent database encoding issues.
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
    .replace(/[^\x00-\x7F]/g, '')
    .trim();
}

interface SellParams {
  marketQuery: string;
  outcome: 'Yes' | 'No';
  shares?: number;
  percentage?: number;
  minPrice?: number;
}

/**
 * Parse sell parameters from user message text
 */
function parseUserMessage(text: string): Partial<SellParams> {
  const params: Partial<SellParams> = {};

  // Extract share count
  const sharesMatch = text.match(/(\d+(?:\.\d+)?)\s*shares?/i);
  if (sharesMatch) {
    params.shares = parseFloat(sharesMatch[1]);
  }

  // Extract percentage
  const percentMatch = text.match(/(\d+)%/);
  if (percentMatch) {
    params.percentage = parseInt(percentMatch[1]);
  }

  // Determine outcome (Yes/No)
  const lowerText = text.toLowerCase();
  if (lowerText.includes(' yes') || lowerText.includes('yes ') || lowerText.match(/\byes\b/)) {
    params.outcome = 'Yes';
  } else if (lowerText.includes(' no') || lowerText.includes('no ') || lowerText.match(/\bno\b/)) {
    params.outcome = 'No';
  }

  // Extract market query
  let query = text
    .replace(/\d+(?:\.\d+)?\s*shares?/gi, '')
    .replace(/\d+%/g, '')
    .replace(/\b(?:sell|close|exit|dump|liquidate)\b/gi, '')
    .replace(/\b(?:my|the|position|trade)\b/gi, ' ')
    .replace(/\b(?:yes|no)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (query.length > 3) {
    params.marketQuery = query;
  }

  return params;
}

export const sellOutcomeAction: Action = {
  name: 'SELL_PREDICTION',
  similes: [
    'SELL_OUTCOME',
    'SELL_SHARES',
    'CLOSE_POSITION',
    'EXIT_TRADE',
    'TAKE_PROFIT',
    'CUT_LOSSES',
  ],
  description: 'Sell shares of a prediction market outcome on Polymarket',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    const sellKeywords = ['sell', 'close', 'exit', 'take profit', 'cut', 'dump', 'liquidate'];
    const marketKeywords = ['position', 'shares', 'market', 'prediction', 'polymarket', 'trade'];

    const hasSellIntent = sellKeywords.some(k => text.includes(k));
    const hasMarketContext = marketKeywords.some(k => text.includes(k));

    return hasSellIntent && hasMarketContext;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
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

      if (service.isReadOnly()) {
        const errorMsg = 'Trading is disabled. Configure POLYMARKET_PRIVATE_KEY to enable.';
        if (callback) {
          await callback({ text: errorMsg, error: true });
        }
        return { success: false, error: errorMsg };
      }

      const text = message.content.text || '';

      // Try to use LLM to extract parameters, fall back to regex parsing
      let params: Partial<SellParams> = {};

      try {
        const extractionPrompt = `Extract trading parameters from this sell message: "${text}"

Return a JSON object with:
- marketQuery: the market topic/question (string)
- outcome: "Yes" or "No" if mentioned
- shares: number of shares to sell (number, optional)
- percentage: percentage of position to sell (number, optional)
- minPrice: minimum price per share (number, optional)

JSON:`;

        const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
          prompt: extractionPrompt,
          schema: {
            type: 'object',
            properties: {
              marketQuery: { type: 'string' },
              outcome: { type: 'string' },
              shares: { type: 'number' },
              percentage: { type: 'number' },
              minPrice: { type: 'number' },
            },
            required: ['marketQuery'],
          },
        });

        if (result && typeof result === 'object') {
          params = result as Partial<SellParams>;
        }
      } catch (extractError) {
        logger.debug({ extractError }, '[SellAction] LLM extraction failed, using regex fallback');
      }

      // Fall back to regex parsing if needed
      if (!params.marketQuery) {
        const parsedParams = parseUserMessage(text);
        params = { ...parsedParams, ...params };
      }

      // Validate required parameters
      if (!params.marketQuery) {
        const errorMsg = 'Please specify which position to sell. Example: "Sell my Bitcoin ETF position"';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      // Find matching position
      const positions = service.getPositions();
      const position = positions.find(p => {
        const matchesMarket = p.market.question.toLowerCase().includes(params.marketQuery!.toLowerCase());
        const matchesOutcome = !params.outcome || p.outcome.toLowerCase() === params.outcome.toLowerCase();
        return matchesMarket && matchesOutcome;
      });

      if (!position) {
        // Search for market anyway to get token info
        const markets = await service.searchMarkets(params.marketQuery, 5);

        if (markets.length === 0) {
          const errorMsg = `No matching position or market found for "${params.marketQuery}".`;
          if (callback) {
            await callback({ text: errorMsg });
          }
          return { success: false, error: errorMsg };
        }

        const market = markets[0];
        const outcome = params.outcome || 'Yes';
        const token = market.tokens.find(t => t.outcome.toLowerCase() === outcome.toLowerCase());

        if (!token) {
          const errorMsg = `Outcome "${outcome}" not found.`;
          if (callback) {
            await callback({ text: errorMsg });
          }
          return { success: false, error: errorMsg };
        }

        // Assume user wants to sell whatever they have
        const warnMsg = `No tracked position found, but proceeding with sell order. Make sure you have shares to sell.`;
        if (callback) {
          await callback({ text: warnMsg });
        }
      }

      // Calculate shares to sell
      let sharesToSell = params.shares;
      if (!sharesToSell && params.percentage && position) {
        sharesToSell = position.size * (params.percentage / 100);
      } else if (!sharesToSell && position) {
        sharesToSell = position.size; // Sell all
      } else if (!sharesToSell) {
        const errorMsg = 'Please specify the number of shares to sell or a percentage. Example: "Sell 50% of my position"';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      // Get current price
      const tokenId = position?.token_id || '';
      if (!tokenId) {
        const errorMsg = 'Could not determine token ID for the position.';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      const currentPrice = await service.getPrice(tokenId);
      const priceToUse = params.minPrice ? Math.max(currentPrice, params.minPrice) : currentPrice;

      if (callback) {
        await callback({
          text: `Placing sell order for ${sharesToSell.toFixed(2)} shares at $${priceToUse.toFixed(4)}/share...`,
        });
      }

      const result = await service.placeOrder({
        tokenId,
        side: 'SELL',
        price: priceToUse,
        size: sharesToSell,
        orderType: 'GTC',
      });

      const totalValue = sharesToSell * priceToUse;
      const pnl = position ? (priceToUse - position.avgPrice) * sharesToSell : 0;

      const successMsg = `Sell order placed!
- Order ID: ${result.orderId}
- Status: ${result.status}
- Shares: ${sharesToSell.toFixed(2)}
- Price: $${priceToUse.toFixed(4)}/share
- Total: $${totalValue.toFixed(2)}
${position ? `- P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : ''}`;

      if (callback) {
        await callback({
          text: successMsg,
          action: 'SELL_PREDICTION',
        });
      }

      return {
        success: true,
        text: successMsg,
        data: {
          orderId: result.orderId,
          status: result.status,
          shares: sharesToSell,
          price: priceToUse,
          totalValue,
          pnl,
        },
      };
    } catch (error) {
      const errorMsg = `Failed to sell: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[SellOutcomeAction] Error');

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
          text: 'Sell my Bitcoin ETF position',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Placing sell order for 100.00 shares at $0.75/share...',
          action: 'SELL_PREDICTION',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'Close 50% of my Trump election position',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Placing sell order for 83.33 shares at $0.65/share...',
          action: 'SELL_PREDICTION',
        },
      },
    ],
  ],
};
