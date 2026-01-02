/**
 * View Markets Action
 *
 * Allows users to search and browse prediction markets with detailed analysis.
 * Supports category-based filtering and provides comprehensive market data.
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
import type { PolymarketMarket } from '../types';

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

/**
 * Category keywords for detection
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  crypto: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'defi', 'blockchain', 'token', 'coin', 'web3'],
  sports: ['sports', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'super bowl', 'championship', 'game', 'match', 'finals', 'world cup'],
  politics: ['politics', 'election', 'president', 'trump', 'biden', 'congress', 'senate', 'vote', 'political', 'democrat', 'republican', 'governor'],
  finance: ['finance', 'fed', 'interest rate', 'inflation', 'stock', 'economy', 'gdp', 'recession', 'market crash'],
  tech: ['tech', 'technology', 'ai', 'apple', 'google', 'microsoft', 'meta', 'openai', 'tesla', 'elon'],
  entertainment: ['entertainment', 'oscar', 'grammy', 'movie', 'tv', 'celebrity', 'music', 'award', 'emmy'],
  world: ['world', 'ukraine', 'russia', 'china', 'war', 'international', 'treaty', 'conflict', 'geopolitical'],
};

/**
 * Keywords that indicate user wants to see resolution markets (>95% skewed)
 */
const RESOLUTION_KEYWORDS = ['resolution', 'resolving', 'awaiting', 'decided', 'settled', 'concluded', 'ended', 'finished', 'outcome', 'result'];

/**
 * Detect category from user text
 */
function detectCategory(text: string): string | null {
  const lowerText = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return category;
      }
    }
  }
  return null;
}

/**
 * Detect if user wants to see resolution markets (>95% skewed)
 */
function wantsResolutionMarkets(text: string): boolean {
  const lowerText = text.toLowerCase();
  return RESOLUTION_KEYWORDS.some(keyword => lowerText.includes(keyword));
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
 * Format time remaining until market end date
 */
function formatTimeRemaining(endDateIso: string): string {
  if (!endDateIso) return 'ongoing';
  const endDate = new Date(endDateIso);
  const now = new Date();
  const hoursRemaining = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursRemaining < 0) return 'awaiting resolution';
  if (hoursRemaining < 1) return '<1 hour';
  if (hoursRemaining < 24) return `${Math.round(hoursRemaining)}h`;
  if (hoursRemaining < 168) return `${Math.round(hoursRemaining / 24)}d`;
  return `${Math.round(hoursRemaining / 168)}w`;
}

/**
 * Analyze market characteristics for insights
 */
function analyzeMarket(m: PolymarketMarket): {
  sentiment: string;
  volatilityIndicator: string;
  tradingOpportunity: string;
} {
  const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const yesPrice = yesToken?.price ?? 0.5;
  const volume = m.volume_num || 0;
  const liquidity = m.liquidity || 0;
  const spread = m.spread || 0;

  // Sentiment based on odds
  let sentiment = 'neutral';
  if (yesPrice >= 0.7) sentiment = 'strongly bullish';
  else if (yesPrice >= 0.55) sentiment = 'moderately bullish';
  else if (yesPrice <= 0.3) sentiment = 'strongly bearish';
  else if (yesPrice <= 0.45) sentiment = 'moderately bearish';

  // Volatility based on volume/liquidity ratio and spread
  let volatilityIndicator = 'moderate';
  const volLiqRatio = volume / Math.max(liquidity, 1);
  if (volLiqRatio > 20 || spread > 0.05) volatilityIndicator = 'high';
  else if (volLiqRatio < 5 && spread < 0.02) volatilityIndicator = 'low';

  // Trading opportunity assessment
  let tradingOpportunity = 'standard';
  if (spread < 0.02 && liquidity > 50000) tradingOpportunity = 'liquid - good for larger positions';
  else if (spread > 0.08) tradingOpportunity = 'wide spread - use limit orders';
  else if (yesPrice > 0.45 && yesPrice < 0.55) tradingOpportunity = 'contested - high conviction needed';

  return { sentiment, volatilityIndicator, tradingOpportunity };
}

/**
 * Format a single market with detailed analytical data
 */
function formatMarketDetailed(m: PolymarketMarket, index: number, includeAnalysis: boolean = true): string {
  const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
  const yesPrice = yesToken?.price ?? 0.5;
  const noPrice = noToken?.price ?? 0.5;
  const question = sanitizeText(m.question).slice(0, 100);
  const volume = formatVolume(m.volume_num || 0);
  const liquidity = formatVolume(m.liquidity || 0);
  const timeLeft = formatTimeRemaining(m.end_date_iso);
  const spread = ((m.spread || 0) * 100).toFixed(1);

  let base = `${index}. "${question}"\n   Odds: YES ${(yesPrice * 100).toFixed(0)}% / NO ${(noPrice * 100).toFixed(0)}% | Vol: ${volume} | Liq: ${liquidity} | Spread: ${spread}% | Ends: ${timeLeft}`;

  if (includeAnalysis) {
    const analysis = analyzeMarket(m);
    base += `\n   Analysis: ${analysis.sentiment} sentiment, ${analysis.volatilityIndicator} volatility. ${analysis.tradingOpportunity}`;
  }

  return base;
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

      // Extract search parameters from user text
      const text = message.content.text || '';

      // Detect category from user text
      const detectedCategory = detectCategory(text);

      // Check if user wants resolution markets (>95% skewed)
      const includeResolution = wantsResolutionMarkets(text);

      // Extract specific query if quoted or after keywords
      let specificQuery = '';
      const quotedMatch = text.match(/"([^"]+)"/);
      if (quotedMatch) {
        specificQuery = quotedMatch[1];
      } else {
        // Extract keywords after "about", "for", "on", etc.
        const aboutMatch = text.match(/(?:about|for|on|regarding)\s+(.+?)(?:\?|$)/i);
        if (aboutMatch) {
          specificQuery = aboutMatch[1].trim();
        }
      }

      // Determine limit
      const limitMatch = text.match(/(\d+)\s*(?:markets?|results?)/i);
      const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 10) : 5;

      logger.info({ detectedCategory, specificQuery, limit, includeResolution }, '[ViewMarketsAction] Fetching markets');

      // Fetch markets based on detected category or query
      let markets: PolymarketMarket[] = [];
      let searchContext = '';

      // Build search params with resolution flag
      const searchParams = { includeResolution };

      if (detectedCategory) {
        // Use category-based search for better filtering
        // Note: getMarketsByCategory uses getMarkets internally, which now respects includeResolution
        markets = await service.getMarketsByCategory(detectedCategory, limit * 2);
        searchContext = `${detectedCategory.toUpperCase()} markets`;
        if (includeResolution) searchContext += ' (including resolution phase)';
        logger.info({ category: detectedCategory, count: markets.length, includeResolution }, '[ViewMarketsAction] Category search');
      } else if (specificQuery) {
        // Use specific query search
        markets = await service.searchMarkets(specificQuery, limit * 2);
        searchContext = `markets for "${sanitizeText(specificQuery)}"`;
        if (includeResolution) searchContext += ' (including resolution phase)';
      } else {
        // Get trending/high-volume markets
        markets = await service.getTrendingMarkets({ limit: limit * 2, minVolume: 5000 });
        searchContext = 'trending markets';
      }

      // Sort by volume and take top results
      markets = markets
        .sort((a, b) => (b.volume_num || 0) - (a.volume_num || 0))
        .slice(0, limit);

      if (markets.length === 0) {
        const noResultsMsg = detectedCategory
          ? `No active ${detectedCategory} markets found right now. Try a different category.`
          : specificQuery
            ? `No markets found for "${sanitizeText(specificQuery)}". Try different search terms.`
            : 'No active markets found at the moment.';
        if (callback) {
          await callback({ text: noResultsMsg });
        }
        return { success: true, text: noResultsMsg, data: { markets: [] } };
      }

      // Format markets with detailed analytical data
      const formattedMarkets = markets.map((m, i) => formatMarketDetailed(m, i + 1, true));

      // Calculate aggregate stats
      const totalVolume = markets.reduce((sum, m) => sum + (m.volume_num || 0), 0);
      const avgLiquidity = markets.reduce((sum, m) => sum + (m.liquidity || 0), 0) / markets.length;
      const avgSpread = markets.reduce((sum, m) => sum + (m.spread || 0), 0) / markets.length;

      // Aggregate sentiment analysis
      const sentimentCounts = { bullish: 0, bearish: 0, neutral: 0 };
      for (const m of markets) {
        const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
        const yesPrice = yesToken?.price ?? 0.5;
        if (yesPrice >= 0.55) sentimentCounts.bullish++;
        else if (yesPrice <= 0.45) sentimentCounts.bearish++;
        else sentimentCounts.neutral++;
      }

      // Build comprehensive response with market overview
      const header = `MARKET ANALYSIS: ${searchContext}\n` +
        `Found ${markets.length} markets | Total Volume: ${formatVolume(totalVolume)} | Avg Liquidity: ${formatVolume(avgLiquidity)} | Avg Spread: ${(avgSpread * 100).toFixed(2)}%\n` +
        `Market Sentiment: ${sentimentCounts.bullish} bullish, ${sentimentCounts.bearish} bearish, ${sentimentCounts.neutral} neutral\n\n`;

      const responseText = header + formattedMarkets.join('\n\n');

      logger.info({
        category: detectedCategory,
        query: specificQuery,
        marketCount: markets.length,
        totalVolume,
      }, '[ViewMarketsAction] Sending response');

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
          category: detectedCategory,
          query: specificQuery,
          markets: markets.map(m => ({
            conditionId: m.condition_id,
            question: m.question,
            tokens: m.tokens,
            volume: m.volume_num,
            liquidity: m.liquidity,
            spread: m.spread,
            endDate: m.end_date_iso,
            active: m.active,
          })),
          stats: {
            totalVolume,
            avgLiquidity,
            marketCount: markets.length,
          },
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
          text: 'MARKET ANALYSIS: CRYPTO markets\nFound 5 markets | Total Volume: $12.5M | Avg Liquidity: $650K | Avg Spread: 1.25%\nMarket Sentiment: 3 bullish, 1 bearish, 1 neutral\n\n1. "Will Bitcoin reach $100k in 2025?"\n   Odds: YES 65% / NO 35% | Vol: $5.2M | Liq: $850K | Spread: 0.8% | Ends: 12d\n   Analysis: moderately bullish sentiment, low volatility. liquid - good for larger positions',
          action: 'VIEW_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'What sports markets are hot right now?',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'MARKET ANALYSIS: SPORTS markets\nFound 5 markets | Total Volume: $8.7M | Avg Liquidity: $780K | Avg Spread: 1.8%\nMarket Sentiment: 2 bullish, 2 bearish, 1 neutral\n\n1. "Super Bowl 2025 winner - Chiefs?"\n   Odds: YES 28% / NO 72% | Vol: $4.5M | Liq: $1.2M | Spread: 1.2% | Ends: 35d\n   Analysis: moderately bearish sentiment, moderate volatility. liquid - good for larger positions',
          action: 'VIEW_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'Show me markets in resolution phase',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'MARKET ANALYSIS: trending markets (including resolution phase)\nFound 3 markets | Total Volume: $2.1M | Avg Liquidity: $150K | Avg Spread: 3.5%\nMarket Sentiment: 2 bullish, 1 bearish, 0 neutral\n\n1. "Will Event X happen by Dec 31?"\n   Odds: YES 98% / NO 2% | Vol: $1.2M | Liq: $80K | Spread: 4.2% | Ends: awaiting resolution\n   Analysis: strongly bullish sentiment, high volatility. wide spread - use limit orders',
          action: 'VIEW_MARKETS',
        },
      },
    ],
  ],
};
