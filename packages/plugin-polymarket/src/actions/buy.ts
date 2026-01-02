/**
 * Buy Outcome Action
 *
 * Allows the agent to buy shares of a prediction market outcome.
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

interface BuyParams {
  marketQuery: string;
  outcome: 'Yes' | 'No';
  amount: number;
  maxPrice?: number;
}

/**
 * Parse buy parameters from user message text
 */
function parseUserMessage(text: string): Partial<BuyParams> {
  const params: Partial<BuyParams> = {};

  // Extract dollar amount
  const amountMatch = text.match(/\$(\d+(?:\.\d{1,2})?)/);
  if (amountMatch) {
    params.amount = parseFloat(amountMatch[1]);
  } else {
    // Try without dollar sign
    const numMatch = text.match(/(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd|on|for)/i);
    if (numMatch) {
      params.amount = parseFloat(numMatch[1]);
    }
  }

  // Determine outcome (Yes/No)
  const lowerText = text.toLowerCase();
  if (lowerText.includes(' yes') || lowerText.includes('yes ') || lowerText.match(/\byes\b/)) {
    params.outcome = 'Yes';
  } else if (lowerText.includes(' no') || lowerText.includes('no ') || lowerText.match(/\bno\b/)) {
    params.outcome = 'No';
  } else if (lowerText.includes('will') || lowerText.includes('wins') || lowerText.includes('passes')) {
    // Default to Yes for positive statements
    params.outcome = 'Yes';
  }

  // Extract market query - remove common phrases and amounts
  let query = text
    .replace(/\$\d+(?:\.\d{1,2})?/g, '')
    .replace(/\b\d+\s*(?:dollars?|usd)\b/gi, '')
    .replace(/\b(?:buy|bet|wager|invest|long|purchase)\b/gi, '')
    .replace(/\b(?:on|for|that|the)\b/gi, ' ')
    .replace(/\b(?:yes|no)\b/gi, '')
    .replace(/\bmarket\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (query.length > 3) {
    params.marketQuery = query;
  }

  return params;
}

export const buyOutcomeAction: Action = {
  name: 'BUY_PREDICTION',
  similes: [
    'BUY_OUTCOME',
    'BUY_SHARES',
    'PLACE_BET',
    'BET_ON',
    'LONG_MARKET',
    'BUY_YES',
    'BUY_NO',
  ],
  description: 'Buy shares of a prediction market outcome on Polymarket',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    // Check if message is about buying/betting on a prediction market
    const buyKeywords = ['buy', 'bet', 'wager', 'invest', 'long', 'purchase'];
    const marketKeywords = ['market', 'prediction', 'polymarket', 'yes', 'no', 'outcome', 'shares'];

    const hasBuyIntent = buyKeywords.some(k => text.includes(k));
    const hasMarketContext = marketKeywords.some(k => text.includes(k));

    // Also check if a dollar amount is mentioned
    const hasAmount = /\$?\d+(\.\d{1,2})?/.test(text);

    return hasBuyIntent && (hasMarketContext || hasAmount);
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
      // Get the Polymarket service
      const service = runtime.getService<PolymarketService>('polymarket');
      if (!service) {
        const errorMsg = 'Polymarket service not available. Please ensure the plugin is configured.';
        if (callback) {
          await callback({ text: errorMsg, error: true });
        }
        return { success: false, error: errorMsg };
      }

      // Check if in read-only mode
      if (service.isReadOnly()) {
        const errorMsg = 'Trading is disabled. Please configure POLYMARKET_PRIVATE_KEY to enable trading.';
        if (callback) {
          await callback({ text: errorMsg, error: true });
        }
        return { success: false, error: errorMsg };
      }

      const text = message.content.text || '';

      // Try to use LLM to extract parameters, fall back to regex parsing
      let params: Partial<BuyParams> = {};

      try {
        const extractionPrompt = `Extract trading parameters from this message: "${text}"

Return a JSON object with:
- marketQuery: the market topic/question (string)
- outcome: "Yes" or "No"
- amount: the dollar amount (number)
- maxPrice: max price per share if mentioned (number, optional)

JSON:`;

        const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
          prompt: extractionPrompt,
          schema: {
            type: 'object',
            properties: {
              marketQuery: { type: 'string' },
              outcome: { type: 'string' },
              amount: { type: 'number' },
              maxPrice: { type: 'number' },
            },
            required: ['marketQuery', 'outcome', 'amount'],
          },
        });

        if (result && typeof result === 'object') {
          params = result as Partial<BuyParams>;
        }
      } catch (extractError) {
        logger.debug({ extractError }, '[BuyAction] LLM extraction failed, using regex fallback');
      }

      // Fall back to regex parsing if needed
      if (!params.marketQuery || !params.outcome || !params.amount) {
        const parsedParams = parseUserMessage(text);
        params = { ...parsedParams, ...params };
      }

      // Validate required parameters
      if (!params.marketQuery) {
        const errorMsg = 'Please specify which market you want to trade. Example: "Buy $50 on Yes for Bitcoin ETF"';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      if (!params.outcome) {
        const errorMsg = 'Please specify the outcome (Yes or No). Example: "Buy $50 on Yes"';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      if (!params.amount || params.amount <= 0) {
        const errorMsg = 'Please specify the amount to invest. Example: "Buy $50 on Yes"';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      // Normalize outcome
      const outcome = params.outcome.charAt(0).toUpperCase() + params.outcome.slice(1).toLowerCase();
      if (outcome !== 'Yes' && outcome !== 'No') {
        const errorMsg = 'Outcome must be "Yes" or "No"';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      // Search for the market
      const markets = await service.searchMarkets(params.marketQuery, 5);

      if (markets.length === 0) {
        const errorMsg = `No markets found matching "${params.marketQuery}". Try a different search term.`;
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      // Use the first matching market
      const market = markets[0];

      // Find the matching outcome token
      const token = market.tokens.find(
        t => t.outcome.toLowerCase() === outcome.toLowerCase()
      );

      if (!token) {
        const errorMsg = `Outcome "${outcome}" not found in market. Available outcomes: ${market.tokens.map(t => t.outcome).join(', ')}`;
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      // Get current price
      const currentPrice = await service.getPrice(token.token_id);
      const priceToUse = params.maxPrice ? Math.min(currentPrice, params.maxPrice) : currentPrice;

      // Calculate number of shares
      const shares = params.amount / priceToUse;

      // Confirm the trade
      const marketQuestion = sanitizeText(market.question);
      if (callback) {
        await callback({
          text: `Placing order to buy ${shares.toFixed(2)} shares of "${outcome}" on "${marketQuestion}" at $${priceToUse.toFixed(4)}/share (total: $${params.amount.toFixed(2)})...`,
        });
      }

      // Place the order
      const result = await service.placeOrder({
        tokenId: token.token_id,
        side: 'BUY',
        price: priceToUse,
        size: shares,
        orderType: 'GTC',
      });

      const successMsg = `Order placed successfully!
- Order ID: ${result.orderId}
- Status: ${result.status}
- Filled: ${result.filledSize.toFixed(2)} shares
- Remaining: ${result.remainingSize.toFixed(2)} shares
- Market: ${marketQuestion}
- Outcome: ${outcome}
- Price: $${priceToUse.toFixed(4)}/share`;

      if (callback) {
        await callback({
          text: successMsg,
          action: 'BUY_PREDICTION',
        });
      }

      return {
        success: true,
        text: successMsg,
        data: {
          orderId: result.orderId,
          status: result.status,
          market: market.question,
          outcome,
          price: priceToUse,
          shares,
          amount: params.amount,
        },
      };
    } catch (error) {
      const errorMsg = `Failed to place order: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[BuyOutcomeAction] Error');

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
          text: 'Buy $50 on Yes for the Bitcoin ETF approval market',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Placing order to buy 100.00 shares of "Yes" on "Will a Bitcoin ETF be approved?" at $0.50/share (total: $50.00)...',
          action: 'BUY_PREDICTION',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'I want to bet $100 that Trump wins the election',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Placing order to buy 166.67 shares of "Yes" on "Will Trump win the 2024 election?" at $0.60/share (total: $100.00)...',
          action: 'BUY_PREDICTION',
        },
      },
    ],
  ],
};
