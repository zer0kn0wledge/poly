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

/**
 * Format volume for display
 */
function formatVolume(volume: number): string {
  if (volume >= 1000000) return `$${(volume / 1000000).toFixed(1)}M`;
  if (volume >= 1000) return `$${(volume / 1000).toFixed(0)}K`;
  return `$${volume.toFixed(0)}`;
}

/**
 * Analyze order book for trading insights
 */
function analyzeOrderBook(orderBook: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }>; spread: number; midpoint: number } | null): {
  depth: string;
  bidPressure: string;
  liquidity: string;
  recommendation: string;
} {
  if (!orderBook || !orderBook.bids || !orderBook.asks) {
    return {
      depth: 'Unknown',
      bidPressure: 'Unknown',
      liquidity: 'Low',
      recommendation: 'Use limit orders due to unknown liquidity',
    };
  }

  const totalBidSize = orderBook.bids.slice(0, 5).reduce((sum, b) => sum + b.size, 0);
  const totalAskSize = orderBook.asks.slice(0, 5).reduce((sum, a) => sum + a.size, 0);
  const totalDepth = totalBidSize + totalAskSize;

  // Depth assessment
  let depth = 'Shallow';
  if (totalDepth > 10000) depth = 'Deep';
  else if (totalDepth > 1000) depth = 'Moderate';

  // Bid/ask pressure
  let bidPressure = 'Balanced';
  const ratio = totalBidSize / (totalAskSize || 1);
  if (ratio > 1.5) bidPressure = 'Strong buying pressure';
  else if (ratio < 0.67) bidPressure = 'Strong selling pressure';

  // Liquidity assessment
  let liquidity = 'Low';
  if (orderBook.spread < 0.02 && totalDepth > 5000) liquidity = 'High';
  else if (orderBook.spread < 0.05 && totalDepth > 1000) liquidity = 'Moderate';

  // Trading recommendation
  let recommendation = '';
  if (liquidity === 'High') {
    recommendation = 'Market orders viable for positions up to $500';
  } else if (liquidity === 'Moderate') {
    recommendation = 'Use limit orders, expect partial fills on larger positions';
  } else {
    recommendation = 'Only limit orders recommended, expect slippage on market orders';
  }

  return { depth, bidPressure, liquidity, recommendation };
}

/**
 * Calculate risk-reward profile
 */
function calculateRiskReward(yesPrice: number, daysRemaining: number): {
  potentialReturn: string;
  riskLevel: string;
  timeValue: string;
  verdict: string;
} {
  // Potential return if YES wins
  const yesReturn = ((1 / yesPrice) - 1) * 100;
  // Potential return if NO wins (buying NO)
  const noReturn = ((1 / (1 - yesPrice)) - 1) * 100;

  const potentialReturn = `YES pays ${yesReturn.toFixed(0)}% | NO pays ${noReturn.toFixed(0)}%`;

  // Risk level based on probability extremes
  let riskLevel = 'Moderate';
  if (yesPrice >= 0.85 || yesPrice <= 0.15) {
    riskLevel = 'High (extreme odds)';
  } else if (yesPrice >= 0.65 || yesPrice <= 0.35) {
    riskLevel = 'Moderate-High';
  } else if (yesPrice > 0.45 && yesPrice < 0.55) {
    riskLevel = 'High (toss-up)';
  }

  // Time value assessment
  let timeValue = 'Low';
  if (daysRemaining > 90) timeValue = 'High (long duration)';
  else if (daysRemaining > 30) timeValue = 'Moderate';
  else if (daysRemaining > 7) timeValue = 'Low (approaching resolution)';
  else timeValue = 'Minimal (imminent resolution)';

  // Overall verdict
  let verdict = '';
  if (yesPrice > 0.45 && yesPrice < 0.55 && daysRemaining > 30) {
    verdict = 'Contested market with time - wait for catalyst or edge before entry';
  } else if (yesPrice >= 0.75 && daysRemaining < 14) {
    verdict = 'Strong favorite near resolution - limited upside, fade if contrarian thesis';
  } else if (yesPrice <= 0.25 && daysRemaining < 14) {
    verdict = 'Heavy underdog near resolution - small position if thesis supports';
  } else if (yesPrice >= 0.60 && yesPrice <= 0.75) {
    verdict = 'Leaning YES - solid entry if thesis aligns with probability';
  } else if (yesPrice >= 0.25 && yesPrice <= 0.40) {
    verdict = 'Leaning NO - solid entry if thesis aligns with probability';
  } else {
    verdict = 'Evaluate news and catalysts before taking position';
  }

  return { potentialReturn, riskLevel, timeValue, verdict };
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
      const yesPrice = yesToken?.price ?? 0.5;
      const noPrice = noToken?.price ?? 0.5;

      const endDate = new Date(market.end_date_iso);
      const now = new Date();
      const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      const statusText = market.active ? 'Active' : market.closed ? 'Closed' : 'Pending';
      const ordersText = market.accepting_orders ? 'Yes' : 'No';

      const question = sanitizeText(market.question);
      const description = market.description ? sanitizeText(market.description) : '';

      // Analyze order books
      const yesOrderBookAnalysis = analyzeOrderBook(yesToken?.orderBook || null);
      const noOrderBookAnalysis = analyzeOrderBook(noToken?.orderBook || null);

      // Calculate risk-reward profile
      const riskReward = calculateRiskReward(yesPrice, daysRemaining);

      // Format volume
      const volumeFormatted = formatVolume(market.volume_num || 0);
      const liquidityFormatted = formatVolume(market.liquidity || 0);

      // Determine market sentiment
      let marketSentiment = 'Neutral';
      if (yesPrice >= 0.70) marketSentiment = 'Strongly Bullish';
      else if (yesPrice >= 0.55) marketSentiment = 'Moderately Bullish';
      else if (yesPrice <= 0.30) marketSentiment = 'Strongly Bearish';
      else if (yesPrice <= 0.45) marketSentiment = 'Moderately Bearish';

      let responseText = `COMPREHENSIVE MARKET ANALYSIS
${'━'.repeat(50)}
"${question}"
Analysis Date: ${etTime.dateStr} ${etTime.timeStr} ET

CURRENT PRICING
${'─'.repeat(30)}
YES: ${(yesPrice * 100).toFixed(1)}%${yesToken?.orderBook ? ` | Spread: ${(yesToken.orderBook.spread * 100).toFixed(2)}%` : ''}
NO:  ${(noPrice * 100).toFixed(1)}%${noToken?.orderBook ? ` | Spread: ${(noToken.orderBook.spread * 100).toFixed(2)}%` : ''}
Market Sentiment: ${marketSentiment}

MARKET METRICS
${'─'.repeat(30)}
Volume: ${volumeFormatted}
Liquidity: ${liquidityFormatted}
Status: ${statusText} | Accepting Orders: ${ordersText}

ORDER BOOK ANALYSIS (YES)
${'─'.repeat(30)}
Depth: ${yesOrderBookAnalysis.depth}
Pressure: ${yesOrderBookAnalysis.bidPressure}
Liquidity: ${yesOrderBookAnalysis.liquidity}
Execution: ${yesOrderBookAnalysis.recommendation}

RISK-REWARD PROFILE
${'─'.repeat(30)}
Potential Returns: ${riskReward.potentialReturn}
Risk Level: ${riskReward.riskLevel}
Time Value: ${riskReward.timeValue}

TIMELINE
${'─'.repeat(30)}
End Date: ${endDate.toLocaleDateString()}
Time Remaining: ${daysRemaining > 0 ? `${daysRemaining} days` : 'Ended'}`;

      // Add signals section if available
      if (signals.length > 0) {
        responseText += `\n\nACTIVE SIGNALS (${signals.length})`;
        responseText += `\n${'─'.repeat(30)}`;
        for (const signal of signals.slice(0, 3)) {
          responseText += `\n${signal.direction.toUpperCase()} | Confidence: ${signal.confidence}% | Edge: ${signal.edge.toFixed(1)}%`;
          if (signal.reasoning) {
            responseText += `\n  Thesis: ${sanitizeText(signal.reasoning.slice(0, 100))}...`;
          }
        }
      }

      // Add opportunity assessment
      if (marketOpportunity) {
        responseText += `\n\nOPPORTUNITY ASSESSMENT`;
        responseText += `\n${'─'.repeat(30)}`;
        responseText += `\nScore: ${marketOpportunity.score}/100 | Direction: ${marketOpportunity.direction.toUpperCase()}`;
        responseText += `\nConfidence: ${marketOpportunity.confidence}%`;
        if (marketOpportunity.reasoning) {
          responseText += `\nReasoning: ${sanitizeText(marketOpportunity.reasoning.slice(0, 150))}`;
        }
      }

      // Add related news section
      if (relatedNews.length > 0) {
        responseText += `\n\nRELATED NEWS (${relatedNews.length} items)`;
        responseText += `\n${'─'.repeat(30)}`;
        for (const news of relatedNews.slice(0, 3)) {
          const sentiment = news.sentiment ? ` [${news.sentiment}]` : '';
          responseText += `\n- ${sanitizeText(news.title.slice(0, 70))}...${sentiment}`;
          responseText += `\n  Source: ${news.source}`;
        }
      }

      // Trading verdict
      responseText += `\n\n${'━'.repeat(50)}`;
      responseText += `\nTRADING VERDICT: ${riskReward.verdict}`;

      if (description) {
        responseText += `\n\nDESCRIPTION:\n${description.slice(0, 300)}${description.length > 300 ? '...' : ''}`;
      }

      // Add action hints
      responseText += `\n\n${'─'.repeat(30)}`;
      responseText += `\nTo trade: "buy yes on ${market.question.slice(0, 30)}..." or "buy no..."`;

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
          analysis: {
            yesPrice,
            noPrice,
            sentiment: marketSentiment,
            orderBook: yesOrderBookAnalysis,
            riskReward: {
              potentialReturn: riskReward.potentialReturn,
              riskLevel: riskReward.riskLevel,
              timeValue: riskReward.timeValue,
              verdict: riskReward.verdict,
            },
            daysRemaining,
          },
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
          text: 'COMPREHENSIVE MARKET ANALYSIS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"Will Bitcoin reach $150k in 2026?"\nAnalysis Date: 2026-01-02 10:30 AM ET\n\nCURRENT PRICING\n──────────────────────────────────\nYES: 65.2% | Spread: 1.25%\nNO:  34.8% | Spread: 1.30%\nMarket Sentiment: Moderately Bullish\n\nMARKET METRICS\n──────────────────────────────────\nVolume: $2.5M\nLiquidity: $450K\nStatus: Active | Accepting Orders: Yes\n\nORDER BOOK ANALYSIS (YES)\n──────────────────────────────────\nDepth: Moderate\nPressure: Balanced\nLiquidity: Moderate\nExecution: Use limit orders, expect partial fills on larger positions\n\nRISK-REWARD PROFILE\n──────────────────────────────────\nPotential Returns: YES pays 53% | NO pays 187%\nRisk Level: Moderate-High\nTime Value: High (long duration)\n\nTRADING VERDICT: Leaning YES - solid entry if thesis aligns with probability',
          action: 'MARKET_DETAILS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'What are the odds on the Super Bowl?',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'COMPREHENSIVE MARKET ANALYSIS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"Will Chiefs win Super Bowl 2026?"\nAnalysis Date: 2026-01-02 10:30 AM ET\n\nCURRENT PRICING\n──────────────────────────────────\nYES: 32.0% | Spread: 2.10%\nNO:  68.0% | Spread: 2.05%\nMarket Sentiment: Moderately Bearish\n\nMARKET METRICS\n──────────────────────────────────\nVolume: $1.8M\nLiquidity: $320K\n\nRISK-REWARD PROFILE\n──────────────────────────────────\nPotential Returns: YES pays 213% | NO pays 47%\nRisk Level: Moderate\nTime Value: Low (approaching resolution)\n\nTRADING VERDICT: Leaning NO - solid entry if thesis aligns with probability',
          action: 'MARKET_DETAILS',
        },
      },
    ],
  ],
};
