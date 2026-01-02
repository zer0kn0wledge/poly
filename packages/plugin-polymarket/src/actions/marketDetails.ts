/**
 * Market Details Action
 *
 * Get detailed information about a specific market with news,
 * signals, and intelligence insights.
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
import { DataSourcesService } from '../services/data-sources';
import { MarketIntelligenceService } from '../services/market-intelligence';
import { SignalGeneratorService } from '../services/signal-generator';
import { getCurrentETTime } from '../providers/timezone';

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

/**
 * Extract keywords from text for news matching.
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'will', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'to', 'of', 'in', 'for', 'on',
    'with', 'at', 'by', 'from', 'or', 'and', 'as', 'if', 'but', 'not', 'that',
    'this', 'it', 'its', 'what', 'which', 'who', 'when', 'where', 'why', 'how',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  ]);

  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .filter((word, index, self) => self.indexOf(word) === index);
}

export const marketDetailsAction: Action = {
  name: 'MARKET_DETAILS',
  similes: [
    'GET_MARKET',
    'MARKET_INFO',
    'SHOW_MARKET',
    'MARKET_DATA',
    'ANALYZE_MARKET',
  ],
  description: 'Get detailed information about a specific prediction market',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    const detailKeywords = ['details', 'detail', 'info', 'information', 'analyze', 'about', 'tell me'];
    const marketKeywords = ['market', 'prediction', 'odds', 'price'];

    const hasDetailIntent = detailKeywords.some(k => text.includes(k));
    const hasMarketContext = marketKeywords.some(k => text.includes(k));

    // Also match patterns like "what are the odds on X"
    const oddsPattern = /what.+odds|odds.+on|price.+on/i;

    return (hasDetailIntent && hasMarketContext) || oddsPattern.test(text);
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
      const dataSourcesService = runtime.getService<DataSourcesService>('data-sources');
      const intelligenceService = runtime.getService<MarketIntelligenceService>('market-intelligence');
      const signalService = runtime.getService<SignalGeneratorService>('signal-generator');

      if (!service) {
        const errorMsg = 'Polymarket service not available.';
        if (callback) {
          await callback({ text: errorMsg, error: true });
        }
        return { success: false, error: errorMsg };
      }

      const text = message.content.text || '';

      // Extract market query
      let query = '';
      const quotedMatch = text.match(/"([^"]+)"/);
      if (quotedMatch) {
        query = quotedMatch[1];
      } else {
        // Try to extract the subject
        const patterns = [
          /(?:about|on|for|regarding)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
          /(?:details|info|information)\s+(?:on|about|for)\s+(.+?)(?:\?|$)/i,
          /(?:odds|price)\s+(?:on|for)\s+(.+?)(?:\?|$)/i,
        ];

        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            query = match[1].trim();
            break;
          }
        }
      }

      if (!query) {
        const errorMsg = 'Please specify which market you want details on. Example: "Tell me about the Bitcoin ETF market"';
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      if (callback) {
        await callback({ text: `Analyzing market: "${query}"...` });
      }

      // Search for the market
      const markets = await service.searchMarkets(query, 1);

      if (markets.length === 0) {
        const errorMsg = `No market found for "${query}". Try a different search term.`;
        if (callback) {
          await callback({ text: errorMsg });
        }
        return { success: false, error: errorMsg };
      }

      const market = markets[0];
      const etTime = getCurrentETTime();

      // Gather market data, news, and signals in parallel
      const [orderBooks, allNews, signals, opportunities] = await Promise.all([
        // Get order book for each token
        Promise.all(
          market.tokens.map(async (token) => {
            try {
              const orderBook = await service.getOrderBook(token.token_id);
              return { ...token, orderBook };
            } catch {
              return { ...token, orderBook: null };
            }
          })
        ),
        // Get related news
        dataSourcesService?.getAllNews() || [],
        // Get active signals for this market
        signalService?.getSignalsByMarket(market.condition_id) || [],
        // Get opportunities for this market
        intelligenceService?.getOpportunities() || [],
      ]);

      // Extract keywords for news filtering
      const marketKeywords = extractKeywords(market.question);

      // Find related news
      const relatedNews = allNews
        .filter((n) => {
          const newsKeywords = extractKeywords(n.title + ' ' + n.summary);
          return marketKeywords.some((mk) => newsKeywords.includes(mk));
        })
        .slice(0, 5);

      // Find opportunities for this market
      const marketOpportunity = opportunities.find((o) => o.market.condition_id === market.condition_id);

      const tokenDetails = orderBooks;

      // Format response - no emojis (can cause DB encoding issues)
      const yesToken = tokenDetails.find((t) => t.outcome.toLowerCase() === 'yes');
      const noToken = tokenDetails.find((t) => t.outcome.toLowerCase() === 'no');

      const endDate = new Date(market.end_date_iso);
      const now = new Date();
      const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      const statusText = market.active ? 'Active' : market.closed ? 'Closed' : 'Pending';
      const ordersText = market.accepting_orders ? 'Yes' : 'No';

      const question = sanitizeText(market.question);
      const description = market.description ? sanitizeText(market.description) : '';

      // Format volume
      const volumeFormatted =
        market.volume_num >= 1_000_000
          ? `$${(market.volume_num / 1_000_000).toFixed(1)}M`
          : `$${(market.volume_num / 1_000).toFixed(0)}K`;

      const liquidityFormatted =
        market.liquidity >= 1_000_000
          ? `$${(market.liquidity / 1_000_000).toFixed(1)}M`
          : `$${(market.liquidity / 1_000).toFixed(0)}K`;

      let responseText = `MARKET ANALYSIS: ${question}
${'='.repeat(Math.min(60, question.length))}
Analysis Date: ${etTime.dateStr} ${etTime.timeStr} ET

PRICING:
- YES: ${((yesToken?.price ?? 0.5) * 100).toFixed(1)}%${yesToken?.orderBook ? ` (spread: ${(yesToken.orderBook.spread * 100).toFixed(2)}%)` : ''}
- NO: ${((noToken?.price ?? 0.5) * 100).toFixed(1)}%${noToken?.orderBook ? ` (spread: ${(noToken.orderBook.spread * 100).toFixed(2)}%)` : ''}

MARKET METRICS:
- Volume: ${volumeFormatted}
- Liquidity: ${liquidityFormatted}
- Status: ${statusText}
- Orders: ${ordersText}

TIMELINE:
- End Date: ${endDate.toLocaleDateString()}
- Time Remaining: ${daysRemaining > 0 ? `${daysRemaining} days` : 'Ended'}`;

      // Add signals section if available
      if (signals.length > 0) {
        responseText += `\n\nACTIVE SIGNALS (${signals.length}):`;
        for (const signal of signals.slice(0, 3)) {
          responseText += `\n- ${signal.direction} @ ${signal.confidence}% confidence | Edge: ${signal.edge.toFixed(1)}%`;
          if (signal.reasoning) {
            responseText += `\n  Thesis: ${sanitizeText(signal.reasoning.slice(0, 100))}...`;
          }
        }
      }

      // Add opportunity assessment
      if (marketOpportunity) {
        responseText += `\n\nOPPORTUNITY SCORE: ${marketOpportunity.score}/100`;
        responseText += `\nDirection: ${marketOpportunity.direction.toUpperCase()}`;
        responseText += `\nConfidence: ${marketOpportunity.confidence}%`;
        if (marketOpportunity.reasoning) {
          responseText += `\nReasoning: ${sanitizeText(marketOpportunity.reasoning.slice(0, 150))}`;
        }
      }

      // Add related news section
      if (relatedNews.length > 0) {
        responseText += `\n\nRELATED NEWS (${relatedNews.length}):`;
        for (const news of relatedNews.slice(0, 3)) {
          const sentiment = news.sentiment ? ` [${news.sentiment}]` : '';
          responseText += `\n- [${news.source}] ${sanitizeText(news.title.slice(0, 70))}...${sentiment}`;
        }
      }

      if (description) {
        responseText += `\n\nDESCRIPTION:\n${description.slice(0, 300)}${description.length > 300 ? '...' : ''}`;
      }

      // Add action hints
      responseText += `\n\n---\nTo trade: "buy yes on ${market.question.slice(0, 30)}..." or "buy no..."`;

      if (callback) {
        await callback({
          text: responseText,
          action: 'MARKET_DETAILS',
        });
      }

      return {
        success: true,
        text: responseText,
        data: {
          market,
          tokens: tokenDetails,
          signals,
          relatedNews,
          opportunity: marketOpportunity,
        },
      };
    } catch (error) {
      const errorMsg = `Failed to get market details: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[MarketDetailsAction] Error');

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
          text: 'Tell me about the Bitcoin ETF market',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Will a Bitcoin ETF be approved in 2024?\n\nCurrent Odds:\n- Yes: 72.5%\n- No: 27.5%\n\nMarket Stats:\n- Volume: $2,345,678\n- Liquidity: $123,456',
          action: 'MARKET_DETAILS',
        },
      },
    ],
  ],
};
