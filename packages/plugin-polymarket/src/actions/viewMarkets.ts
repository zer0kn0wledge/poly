/**
 * View Markets Action - CRYPTO PRICE PREDICTIONS ONLY
 *
 * Zeracle focuses EXCLUSIVELY on crypto price prediction markets.
 * Uses CryptoMarketDiscoveryService to filter to only price-based crypto markets.
 * NO politics, NO sports, NO general events - ONLY crypto price betting.
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
import { CryptoMarketDiscoveryService, type CryptoPriceMarket } from '../services/crypto-market-discovery.service';
import { CoinGeckoDataService } from '../services/coingecko-data.service';
import { TechnicalAnalysisService } from '../services/technical-analysis.service';
import { EdgeCalculatorService, type TradingOpportunity } from '../services/edge-calculator.service';

/**
 * Format volume for display
 */
function formatVolume(volume: number | undefined | null): string {
  if (!volume && volume !== 0) return '$0';
  if (volume >= 1000000) return `$${(volume / 1000000).toFixed(1)}M`;
  if (volume >= 1000) return `$${(volume / 1000).toFixed(0)}K`;
  return `$${volume.toFixed(0)}`;
}

/**
 * Format time remaining
 */
function formatTimeRemaining(daysToExpiry: number): string {
  if (daysToExpiry < 0) return 'expired';
  if (daysToExpiry < 1) return '<1 day';
  if (daysToExpiry < 7) return `${Math.round(daysToExpiry)}d`;
  return `${Math.round(daysToExpiry / 7)}w`;
}

/**
 * Format a crypto price market for display
 */
function formatCryptoMarket(market: CryptoPriceMarket, index: number): string {
  const direction = market.direction === 'ABOVE' ? 'above' :
                    market.direction === 'BELOW' ? 'below' : 'reach';

  return `${index}. ${market.coinSymbol} - ${direction} $${market.targetPrice.toLocaleString()}
   "${market.question.slice(0, 80)}${market.question.length > 80 ? '...' : ''}"
   YES: ${(market.yesPrice * 100).toFixed(0)}% | NO: ${(market.noPrice * 100).toFixed(0)}%
   Volume: ${formatVolume(market.volume)} | Liquidity: ${formatVolume(market.liquidity)}
   Expires: ${formatTimeRemaining(market.daysToExpiry)}`;
}

/**
 * Format opportunity with edge data
 */
function formatOpportunity(opp: TradingOpportunity, index: number): string {
  const market = opp.market;
  const ta = opp.technicalAnalysis;

  return `${index}. [${opp.rating}] ${market.coinSymbol} - $${market.targetPrice.toLocaleString()} target
   Current Price: $${opp.currentPrice.toLocaleString()} (${opp.distanceToTarget > 0 ? '+' : ''}${opp.distanceToTarget.toFixed(1)}% to target)
   Market: YES ${(opp.marketImpliedProbability * 100).toFixed(0)}% | Model: ${(opp.estimatedProbability * 100).toFixed(0)}%
   Edge: ${opp.edge > 0 ? '+' : ''}${opp.edgePercent.toFixed(1)}% on ${opp.side}

   Technical Analysis:
   - Trend: ${ta.trendDirection} (${(ta.trendStrength * 100).toFixed(0)}% strength)
   - RSI: ${ta.rsi.toFixed(0)} (${ta.rsiSignal})
   - MACD: ${ta.macdSignal}
   - Bollinger: ${ta.bollingerSignal || 'NEUTRAL'}

   Recommendation: BUY ${opp.side} | Size: $${opp.recommendedSize.toFixed(0)} | Confidence: ${opp.confidence.toFixed(0)}%
   ${opp.riskFactors.length > 0 ? `Risks: ${opp.riskFactors.slice(0, 2).join('; ')}` : ''}`;
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
    'CRYPTO_MARKETS',
    'PRICE_MARKETS',
  ],
  description: 'View crypto price prediction markets with technical analysis',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    const viewKeywords = ['show', 'list', 'find', 'search', 'browse', 'view', 'what', 'which', 'get'];
    const marketKeywords = ['market', 'markets', 'prediction', 'polymarket', 'betting', 'odds', 'crypto', 'price', 'bitcoin', 'btc', 'eth', 'sol'];

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
      // Get crypto-focused services
      const discoveryService = runtime.getService<CryptoMarketDiscoveryService>('crypto-market-discovery');
      const edgeCalculator = runtime.getService<EdgeCalculatorService>('edge-calculator');
      const coinGeckoService = runtime.getService<CoinGeckoDataService>('coingecko-data');

      if (!discoveryService) {
        const errorMsg = 'Crypto market discovery service not available. Initializing...';
        logger.warn('[ViewMarkets] Discovery service not ready');
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      const text = message.content.text?.toLowerCase() || '';

      // Check if user wants specific coin
      const coinKeywords: Record<string, string> = {
        'bitcoin': 'bitcoin',
        'btc': 'bitcoin',
        'ethereum': 'ethereum',
        'eth': 'ethereum',
        'solana': 'solana',
        'sol': 'solana',
        'doge': 'dogecoin',
        'dogecoin': 'dogecoin',
        'xrp': 'ripple',
        'ripple': 'ripple',
        'cardano': 'cardano',
        'ada': 'cardano',
        'bnb': 'binancecoin',
        'avax': 'avalanche-2',
        'avalanche': 'avalanche-2',
      };

      let specificCoin: string | null = null;
      for (const [keyword, coinId] of Object.entries(coinKeywords)) {
        if (text.includes(keyword)) {
          specificCoin = coinId;
          break;
        }
      }

      // Determine limit
      const limitMatch = text.match(/(\d+)\s*(?:markets?|results?)/i);
      const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 10) : 5;

      // Check if user wants full analysis with edge calculation
      const wantsAnalysis = text.includes('analysis') ||
                           text.includes('edge') ||
                           text.includes('opportunity') ||
                           text.includes('trade') ||
                           text.includes('recommend');

      logger.info({ specificCoin, limit, wantsAnalysis }, '[ViewMarkets] Fetching crypto price markets');

      let responseText = '';

      if (wantsAnalysis && edgeCalculator) {
        // Full analysis with edge calculation
        const opportunities = await edgeCalculator.findOpportunities();

        // Filter by coin if specified
        let filtered = specificCoin
          ? opportunities.filter(o => o.market.coin === specificCoin)
          : opportunities;

        // Take top by edge
        filtered = filtered.slice(0, limit);

        if (filtered.length === 0) {
          responseText = specificCoin
            ? `No crypto price markets found for ${specificCoin} with sufficient edge.`
            : 'No crypto price markets found with sufficient trading edge right now.';
        } else {
          const totalEdge = filtered.reduce((sum, o) => sum + Math.abs(o.edge), 0);
          const avgEdge = totalEdge / filtered.length;

          responseText = `CRYPTO PRICE PREDICTION OPPORTUNITIES
================================================================================
Markets Found: ${filtered.length}
Average Edge: ${(avgEdge * 100).toFixed(1)}%
Strong Buys: ${filtered.filter(o => o.rating === 'STRONG_BUY').length}
Buys: ${filtered.filter(o => o.rating === 'BUY').length}

================================================================================
DETAILED ANALYSIS
================================================================================

${filtered.map((opp, i) => formatOpportunity(opp, i + 1)).join('\n\n---\n\n')}`;
        }
      } else {
        // Simple market listing
        let markets: CryptoPriceMarket[];

        if (specificCoin) {
          markets = await discoveryService.getMarketsForCoin(specificCoin, limit);
        } else {
          markets = await discoveryService.getCryptoPriceMarkets(1000, 5000);
          markets = markets.slice(0, limit);
        }

        if (markets.length === 0) {
          responseText = specificCoin
            ? `No crypto price prediction markets found for ${specificCoin}.`
            : 'No crypto price prediction markets found matching criteria.';
        } else {
          // Get current prices for context if CoinGecko available
          let priceContext = '';
          if (coinGeckoService) {
            try {
              const uniqueCoins = [...new Set(markets.map(m => m.coin))];
              const prices = await coinGeckoService.getSimplePrice(uniqueCoins.slice(0, 5));
              if (prices) {
                const priceLines = Object.entries(prices)
                  .map(([coin, data]) => `${coin.toUpperCase()}: $${data.usd.toLocaleString()}`)
                  .join(' | ');
                priceContext = `\nCurrent Prices: ${priceLines}\n`;
              }
            } catch {
              // Ignore price fetch errors
            }
          }

          const totalVolume = markets.reduce((sum, m) => sum + (m.volume || 0), 0);
          const avgLiquidity = markets.reduce((sum, m) => sum + (m.liquidity || 0), 0) / markets.length;

          responseText = `CRYPTO PRICE PREDICTION MARKETS
================================================================================
${specificCoin ? `Coin: ${specificCoin.toUpperCase()}` : 'All Crypto Assets'}
Markets Found: ${markets.length}
Total Volume: ${formatVolume(totalVolume)}
Avg Liquidity: ${formatVolume(avgLiquidity)}
${priceContext}
================================================================================
MARKETS
================================================================================

${markets.map((m, i) => formatCryptoMarket(m, i + 1)).join('\n\n')}

================================================================================
TIP: Ask for "analysis" or "opportunities" to see edge calculations with
technical indicators (RSI, MACD, Bollinger Bands) from CoinGecko data.`;
        }
      }

      logger.info({ marketCount: responseText.includes('Markets Found:') ? 'found' : 'none' }, '[ViewMarkets] Response ready');

      if (callback) {
        await callback({
          text: responseText,
          action: 'VIEW_MARKETS',
        });
      }

      return {
        success: true,
        text: responseText,
        data: { type: 'crypto_price_markets' },
      };

    } catch (error) {
      const errorMsg = `Failed to fetch crypto markets: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[ViewMarkets] Error');

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
          text: 'Show me crypto markets',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: `CRYPTO PRICE PREDICTION MARKETS
================================================================================
All Crypto Assets
Markets Found: 5
Total Volume: $2.5M
Avg Liquidity: $45K

Current Prices: BTC: $97,500 | ETH: $3,650 | SOL: $185
================================================================================
MARKETS
================================================================================

1. BTC - above $100,000
   "Will Bitcoin reach $100k by end of January?"
   YES: 65% | NO: 35%
   Volume: $850K | Liquidity: $65K
   Expires: 2w

2. ETH - above $4,000
   "Will Ethereum reach $4000 in January 2025?"
   YES: 42% | NO: 58%
   Volume: $520K | Liquidity: $48K
   Expires: 2w`,
          action: 'VIEW_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'Show me BTC market opportunities with analysis',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: `CRYPTO PRICE PREDICTION OPPORTUNITIES
================================================================================
Markets Found: 2
Average Edge: 8.5%
Strong Buys: 1
Buys: 1

================================================================================
DETAILED ANALYSIS
================================================================================

1. [STRONG_BUY] BTC - $100,000 target
   Current Price: $97,500 (+2.6% to target)
   Market: YES 65% | Model: 78%
   Edge: +13% on YES

   Technical Analysis:
   - Trend: BULLISH (72% strength)
   - RSI: 58 (NEUTRAL)
   - MACD: BULLISH
   - Bollinger: NEUTRAL

   Recommendation: BUY YES | Size: $45 | Confidence: 75%
   Risks: Short time to expiry`,
          action: 'VIEW_MARKETS',
        },
      },
    ],
  ],
};
