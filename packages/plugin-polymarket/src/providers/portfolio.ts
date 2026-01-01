/**
 * Portfolio Provider
 *
 * Provides context about the user's current positions and portfolio status.
 * This information is injected into the agent's context for trading decisions.
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

export const portfolioProvider: Provider = {
  name: 'POLYMARKET_PORTFOLIO',
  description: 'Provides current Polymarket portfolio and position information',

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
          values: { polymarketEnabled: false },
          data: {},
        };
      }

      if (service.isReadOnly()) {
        return {
          text: 'Polymarket is in read-only mode. Trading requires wallet configuration.',
          values: {
            polymarketEnabled: true,
            polymarketReadOnly: true,
          },
          data: {},
        };
      }

      const portfolio = await service.getPortfolio();
      const riskSettings = service.getRiskSettings();

      // Format position summary for context
      const positionSummary = portfolio.positions.length > 0
        ? portfolio.positions.map(p => {
            const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';
            return `- ${p.market.question} (${p.outcome}): ${p.size.toFixed(2)} shares @ $${p.avgPrice.toFixed(4)}, current: $${p.currentPrice.toFixed(4)}, P&L: ${pnlSign}$${p.unrealizedPnl.toFixed(2)}`;
          }).join('\n')
        : 'No open positions';

      const contextText = `
**Polymarket Portfolio Status:**
- Total Value: $${portfolio.totalValue.toFixed(2)}
- Cash Available: $${portfolio.cashBalance.toFixed(2)}
- Unrealized P&L: ${portfolio.unrealizedPnl >= 0 ? '+' : ''}$${portfolio.unrealizedPnl.toFixed(2)}
- Today's Realized P&L: ${portfolio.realizedPnl >= 0 ? '+' : ''}$${portfolio.realizedPnl.toFixed(2)}

**Risk Limits:**
- Max Position Size: $${riskSettings.maxPositionSize}
- Max Portfolio Risk: $${riskSettings.maxPortfolioRisk}
- Daily Loss Limit: $${riskSettings.maxDailyLoss}
- Stop Loss: ${riskSettings.stopLossPercent}%
- Take Profit: ${riskSettings.takeProfitPercent}%

**Current Positions:**
${positionSummary}
`.trim();

      return {
        text: contextText,
        values: {
          polymarketEnabled: true,
          polymarketReadOnly: false,
          portfolioTotalValue: portfolio.totalValue,
          portfolioCashBalance: portfolio.cashBalance,
          portfolioUnrealizedPnl: portfolio.unrealizedPnl,
          portfolioPositionCount: portfolio.positions.length,
          riskMaxPositionSize: riskSettings.maxPositionSize,
          riskMaxPortfolioRisk: riskSettings.maxPortfolioRisk,
        },
        data: {
          portfolio,
          riskSettings,
        },
      };
    } catch (error) {
      logger.error({ error }, '[PortfolioProvider] Error fetching portfolio');
      return {
        text: 'Unable to fetch Polymarket portfolio status.',
        values: { polymarketError: true },
        data: { error: String(error) },
      };
    }
  },
};
