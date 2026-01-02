/**
 * View Position Action
 *
 * Shows the user's current positions and portfolio.
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

export const viewPositionAction: Action = {
  name: 'VIEW_POSITIONS',
  similes: [
    'VIEW_PORTFOLIO',
    'SHOW_POSITIONS',
    'MY_POSITIONS',
    'CHECK_PORTFOLIO',
    'GET_HOLDINGS',
    'LIST_POSITIONS',
  ],
  description: 'View current prediction market positions and portfolio',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    const viewKeywords = ['show', 'view', 'check', 'what', 'list', 'my'];
    const positionKeywords = ['position', 'positions', 'portfolio', 'holdings', 'balance', 'trades', 'bets'];

    const hasViewIntent = viewKeywords.some(k => text.includes(k));
    const hasPositionContext = positionKeywords.some(k => text.includes(k));

    return hasViewIntent && hasPositionContext;
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

      if (service.isReadOnly()) {
        const errorMsg = 'Wallet not configured. Set POLYMARKET_PRIVATE_KEY to view positions.';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      const portfolio = await service.getPortfolio();
      const positions = portfolio.positions;

      if (positions.length === 0) {
        const noPositionsMsg = `Portfolio Summary:
Cash Balance: $${portfolio.cashBalance.toFixed(2)}
Total Value: $${portfolio.totalValue.toFixed(2)}
Positions: None

You don't have any open positions. Use the search command to find markets to trade.`;

        if (callback) {
          await callback({ text: noPositionsMsg, action: 'VIEW_POSITIONS' });
        }

        return {
          success: true,
          text: noPositionsMsg,
          data: { portfolio },
        };
      }

      // Format positions - no emojis (can cause DB encoding issues)
      const positionsList = positions.map((p, i) => {
        const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';

        return `${i + 1}. ${p.market.question}
   Outcome: ${p.outcome}
   Shares: ${p.size.toFixed(2)} @ $${p.avgPrice.toFixed(4)} avg
   Current: $${p.currentPrice.toFixed(4)}
   P&L: ${pnlSign}$${p.unrealizedPnl.toFixed(2)} (${pnlSign}${p.unrealizedPnlPercent.toFixed(1)}%)`;
      }).join('\n\n');

      const totalPnlSign = portfolio.unrealizedPnl >= 0 ? '+' : '';

      const responseText = `Portfolio Summary:
Cash Balance: $${portfolio.cashBalance.toFixed(2)}
Position Value: $${(portfolio.totalValue - portfolio.cashBalance).toFixed(2)}
Total Value: $${portfolio.totalValue.toFixed(2)}
Unrealized P&L: ${totalPnlSign}$${portfolio.unrealizedPnl.toFixed(2)}
Realized P&L (today): ${portfolio.realizedPnl >= 0 ? '+' : ''}$${portfolio.realizedPnl.toFixed(2)}

Open Positions (${positions.length}):

${positionsList}`;

      if (callback) {
        await callback({
          text: responseText,
          action: 'VIEW_POSITIONS',
        });
      }

      return {
        success: true,
        text: responseText,
        data: { portfolio },
      };
    } catch (error) {
      const errorMsg = `Failed to fetch positions: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[ViewPositionAction] Error');

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
          text: 'Show my positions',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Portfolio Summary:\nCash Balance: $500.00\nTotal Value: $1,234.56\nUnrealized P&L: +$123.45\n\nOpen Positions (2):\n\n1. Will Bitcoin reach $100k?\n   Outcome: Yes\n   Shares: 100.00\n   P&L: +$50.00',
          action: 'VIEW_POSITIONS',
        },
      },
    ],
  ],
};
