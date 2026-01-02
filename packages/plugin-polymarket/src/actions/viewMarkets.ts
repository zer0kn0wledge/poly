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
import { logger, ModelType } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';
import type { PolymarketMarket } from '../types';

// Minimum content depth requirements
const MIN_ANALYSIS_CHARS = 500;
const MIN_MARKET_INSIGHT_CHARS = 150;

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
 * Comprehensive market analysis with deep insights
 */
interface MarketAnalysis {
  sentiment: string;
  sentimentRationale: string;
  volatilityIndicator: string;
  volatilityRationale: string;
  tradingOpportunity: string;
  riskFactors: string[];
  keyInsight: string;
  edgeAssessment: string;
}

/**
 * Analyze market characteristics for comprehensive insights
 */
function analyzeMarket(m: PolymarketMarket): MarketAnalysis {
  const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
  const yesPrice = yesToken?.price ?? 0.5;
  const noPrice = noToken?.price ?? 0.5;
  const volume = m.volume_num || 0;
  const liquidity = m.liquidity || 0;
  const spread = m.spread || 0;
  const volLiqRatio = volume / Math.max(liquidity, 1);

  // Sentiment analysis with rationale
  let sentiment = 'neutral';
  let sentimentRationale = '';
  if (yesPrice >= 0.85) {
    sentiment = 'extremely bullish';
    sentimentRationale = `Market prices ${(yesPrice * 100).toFixed(0)}% probability - near consensus. Consider: is there value in the contrarian NO position at ${(noPrice * 100).toFixed(0)}%?`;
  } else if (yesPrice >= 0.7) {
    sentiment = 'strongly bullish';
    sentimentRationale = `${(yesPrice * 100).toFixed(0)}% YES odds indicate strong market conviction. Volume of ${formatVolume(volume)} suggests institutional interest.`;
  } else if (yesPrice >= 0.55) {
    sentiment = 'moderately bullish';
    sentimentRationale = `Lean YES at ${(yesPrice * 100).toFixed(0)}% but not decisive. Watch for catalyst events that could push conviction higher.`;
  } else if (yesPrice <= 0.15) {
    sentiment = 'extremely bearish';
    sentimentRationale = `Only ${(yesPrice * 100).toFixed(0)}% YES - market sees this as highly unlikely. Contrarian YES at this price offers asymmetric upside if consensus is wrong.`;
  } else if (yesPrice <= 0.3) {
    sentiment = 'strongly bearish';
    sentimentRationale = `${(yesPrice * 100).toFixed(0)}% YES odds - market skeptical. NO position dominant but evaluate if odds properly reflect true probability.`;
  } else if (yesPrice <= 0.45) {
    sentiment = 'moderately bearish';
    sentimentRationale = `Slight bearish lean at ${(yesPrice * 100).toFixed(0)}% YES. Market slightly favors NO outcome but remains contestable.`;
  } else {
    sentiment = 'neutral/contested';
    sentimentRationale = `50/50 territory at ${(yesPrice * 100).toFixed(0)}% YES. High uncertainty - either side viable. Wait for clearer signal or trade mean reversion.`;
  }

  // Volatility analysis with rationale
  let volatilityIndicator = 'moderate';
  let volatilityRationale = '';
  if (volLiqRatio > 30 || spread > 0.08) {
    volatilityIndicator = 'very high';
    volatilityRationale = `Vol/Liq ratio of ${volLiqRatio.toFixed(1)}x and ${(spread * 100).toFixed(1)}% spread indicate active price discovery. Expect 5-10% swings on news.`;
  } else if (volLiqRatio > 20 || spread > 0.05) {
    volatilityIndicator = 'high';
    volatilityRationale = `Elevated turnover (${volLiqRatio.toFixed(1)}x vol/liq) suggests ongoing revaluation. Position sizing should account for 3-5% daily moves.`;
  } else if (volLiqRatio < 3 && spread < 0.015) {
    volatilityIndicator = 'very low';
    volatilityRationale = `Tight spread (${(spread * 100).toFixed(2)}%) and low turnover indicate stable consensus. Price unlikely to move without major catalyst.`;
  } else if (volLiqRatio < 5 && spread < 0.025) {
    volatilityIndicator = 'low';
    volatilityRationale = `Stable trading conditions with ${(spread * 100).toFixed(1)}% spread. Good for patient accumulation strategies.`;
  } else {
    volatilityRationale = `Standard market dynamics. Spread of ${(spread * 100).toFixed(1)}% is workable for most position sizes.`;
  }

  // Trading opportunity assessment
  let tradingOpportunity = '';
  if (spread < 0.015 && liquidity > 100000) {
    tradingOpportunity = `Excellent liquidity ($${(liquidity / 1000).toFixed(0)}K) with tight spread - ideal for positions up to $${Math.floor(liquidity * 0.05 / 1000)}K without significant slippage.`;
  } else if (spread < 0.025 && liquidity > 50000) {
    tradingOpportunity = `Good execution environment. Can comfortably trade $${Math.floor(liquidity * 0.03 / 1000)}K-${Math.floor(liquidity * 0.05 / 1000)}K positions.`;
  } else if (spread > 0.08) {
    tradingOpportunity = `Wide spread (${(spread * 100).toFixed(1)}%) - use limit orders only. Market orders will lose ${(spread * 100).toFixed(1)}% immediately to spread.`;
  } else if (yesPrice > 0.45 && yesPrice < 0.55) {
    tradingOpportunity = `Contested odds near 50/50 - requires high conviction thesis. Consider waiting for clearer directional signal before entry.`;
  } else {
    tradingOpportunity = `Standard trading conditions. Limit orders recommended to capture spread.`;
  }

  // Risk factors
  const riskFactors: string[] = [];
  if (liquidity < 10000) riskFactors.push('Low liquidity risk - difficult to exit large positions');
  if (spread > 0.05) riskFactors.push(`Wide spread (${(spread * 100).toFixed(1)}%) creates immediate mark-to-market loss on entry`);
  if (volLiqRatio > 25) riskFactors.push('High volatility - position sizing critical');
  if (yesPrice > 0.92 || yesPrice < 0.08) riskFactors.push('Extreme odds - limited upside vs potential total loss');
  if (volume < 5000) riskFactors.push('Low volume - potential for manipulation or stale pricing');
  if (riskFactors.length === 0) riskFactors.push('Standard market risk profile');

  // Key insight
  let keyInsight = '';
  if (yesPrice > 0.7 && spread < 0.03 && liquidity > 50000) {
    keyInsight = `High conviction market with institutional-grade liquidity. Smart money appears positioned YES. Contrarian NO only if you have differentiated information.`;
  } else if (yesPrice < 0.3 && spread < 0.03 && liquidity > 50000) {
    keyInsight = `Market strongly expects NO outcome. YES position is contrarian bet - only enter with clear catalyst thesis for probability revision.`;
  } else if (yesPrice > 0.45 && yesPrice < 0.55 && volume > 100000) {
    keyInsight = `High-volume contested market. Suggests genuine uncertainty among sophisticated traders. Edge will come from superior information, not market structure.`;
  } else if (spread > 0.06 && liquidity < 20000) {
    keyInsight = `Thin market with wide spreads - potential for mispricing but also manipulation risk. Trade small, use limits, be patient.`;
  } else {
    keyInsight = `Standard market dynamics. Focus on fundamental analysis of the underlying question rather than market microstructure.`;
  }

  // Edge assessment
  let edgeAssessment = '';
  const impliedProb = yesPrice * 100;
  if (impliedProb > 70) {
    edgeAssessment = `YES priced at ${impliedProb.toFixed(0)}%. Edge exists if true probability is above ${(impliedProb + 5).toFixed(0)}% (YES) or below ${(impliedProb - 15).toFixed(0)}% (contrarian NO).`;
  } else if (impliedProb < 30) {
    edgeAssessment = `YES priced at ${impliedProb.toFixed(0)}%. Edge exists if true probability is below ${(impliedProb - 5).toFixed(0)}% (NO) or above ${(impliedProb + 15).toFixed(0)}% (contrarian YES).`;
  } else {
    edgeAssessment = `YES priced at ${impliedProb.toFixed(0)}%. In contested range - need 10%+ edge estimate to justify position given spread and uncertainty.`;
  }

  return {
    sentiment,
    sentimentRationale,
    volatilityIndicator,
    volatilityRationale,
    tradingOpportunity,
    riskFactors,
    keyInsight,
    edgeAssessment,
  };
}

/**
 * Format a single market with detailed analytical data (brief version for lists)
 */
function formatMarketBrief(m: PolymarketMarket, index: number): string {
  const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
  const yesPrice = yesToken?.price ?? 0.5;
  const noPrice = noToken?.price ?? 0.5;
  const question = sanitizeText(m.question).slice(0, 100);
  const volume = formatVolume(m.volume_num || 0);
  const liquidity = formatVolume(m.liquidity || 0);
  const timeLeft = formatTimeRemaining(m.end_date_iso);
  const spread = ((m.spread || 0) * 100).toFixed(1);

  return `${index}. "${question}"\n   Odds: YES ${(yesPrice * 100).toFixed(0)}% / NO ${(noPrice * 100).toFixed(0)}% | Vol: ${volume} | Liq: ${liquidity} | Spread: ${spread}% | Ends: ${timeLeft}`;
}

/**
 * Format a single market with comprehensive analytical data
 * Meets minimum content depth requirements for professional analysis
 */
function formatMarketDetailed(m: PolymarketMarket, index: number, includeAnalysis: boolean = true): string {
  const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
  const yesPrice = yesToken?.price ?? 0.5;
  const noPrice = noToken?.price ?? 0.5;
  const question = sanitizeText(m.question);
  const volume = formatVolume(m.volume_num || 0);
  const liquidity = formatVolume(m.liquidity || 0);
  const timeLeft = formatTimeRemaining(m.end_date_iso);
  const spread = ((m.spread || 0) * 100).toFixed(1);

  // Base market data
  let output = `${index}. "${question}"
   MARKET DATA:
   - Current Odds: YES ${(yesPrice * 100).toFixed(0)}% / NO ${(noPrice * 100).toFixed(0)}%
   - Total Volume: ${volume}
   - Liquidity Pool: ${liquidity}
   - Bid-Ask Spread: ${spread}%
   - Time to Resolution: ${timeLeft}`;

  if (includeAnalysis) {
    const analysis = analyzeMarket(m);

    output += `

   SENTIMENT ANALYSIS:
   - Market Sentiment: ${analysis.sentiment.toUpperCase()}
   - ${analysis.sentimentRationale}

   VOLATILITY & LIQUIDITY:
   - Volatility: ${analysis.volatilityIndicator.toUpperCase()}
   - ${analysis.volatilityRationale}

   TRADING CONSIDERATIONS:
   - ${analysis.tradingOpportunity}
   - Risk Factors: ${analysis.riskFactors.join('; ')}

   KEY INSIGHT:
   ${analysis.keyInsight}

   EDGE ASSESSMENT:
   ${analysis.edgeAssessment}`;
  }

  return output;
}

/**
 * Generate AI-powered deep analysis for a market using the LLM
 */
async function generateDeepAnalysis(
  runtime: IAgentRuntime,
  market: PolymarketMarket,
  category?: string
): Promise<string> {
  const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const yesPrice = yesToken?.price ?? 0.5;
  const volume = market.volume_num || 0;
  const liquidity = market.liquidity || 0;
  const spread = market.spread || 0;

  const prompt = `You are Zeracle, an elite prediction market analyst providing Bloomberg-grade analysis.

MARKET: "${market.question}"
CATEGORY: ${category || 'General'}
CURRENT ODDS: YES ${(yesPrice * 100).toFixed(0)}% / NO ${((1 - yesPrice) * 100).toFixed(0)}%
TOTAL VOLUME: $${volume.toLocaleString()}
LIQUIDITY: $${liquidity.toLocaleString()}
SPREAD: ${(spread * 100).toFixed(2)}%

Provide a comprehensive analysis (minimum 400 characters) covering:

1. MARKET ASSESSMENT: What is the market pricing and why? Is the consensus correct or is there potential mispricing?

2. KEY FACTORS: What specific events, data points, or catalysts will determine the outcome? Be specific.

3. RISK ANALYSIS: What could go wrong for both YES and NO positions? What's the downside scenario?

4. TRADING THESIS: If you were to take a position, which side and why? What would invalidate your thesis?

5. EDGE OPPORTUNITY: Where might there be market inefficiency? What would smart money be watching?

Requirements:
- Be specific with numbers and percentages
- Reference actual market data provided
- Professional analytical tone
- No emojis or hashtags
- Minimum 400 characters

Write the analysis:`;

  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    if (typeof response === 'string' && response.length >= 200) {
      return sanitizeText(response);
    }
  } catch (error) {
    logger.warn({ error, market: market.question.slice(0, 50) }, '[ViewMarkets] Deep analysis generation failed');
  }

  // Fallback to structured analysis if LLM fails
  const analysis = analyzeMarket(market);
  return `MARKET ASSESSMENT: ${analysis.sentimentRationale}

VOLATILITY PROFILE: ${analysis.volatilityRationale}

TRADING CONSIDERATIONS: ${analysis.tradingOpportunity}

RISK FACTORS: ${analysis.riskFactors.join('. ')}

KEY INSIGHT: ${analysis.keyInsight}

EDGE ASSESSMENT: ${analysis.edgeAssessment}`;
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
        // Use category-specific methods that use proper tag_id filtering
        const categoryLower = detectedCategory.toLowerCase();
        logger.info({ category: categoryLower }, '[ViewMarketsAction] Using category-specific method');

        if (categoryLower === 'sports') {
          markets = await service.getSportsMarkets(limit * 2);
        } else if (categoryLower === 'crypto') {
          markets = await service.getCryptoMarkets(limit * 2);
        } else if (categoryLower === 'politics') {
          markets = await service.getPoliticsMarkets(limit * 2);
        } else if (categoryLower === 'economics' || categoryLower === 'finance') {
          markets = await service.getEconomicsMarkets(limit * 2);
        } else {
          // Fallback to keyword-based search for other categories
          markets = await service.getMarketsByCategory(detectedCategory, limit * 2);
        }

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

      // Calculate aggregate stats first
      const totalVolume = markets.reduce((sum, m) => sum + (m.volume_num || 0), 0);
      const avgLiquidity = markets.reduce((sum, m) => sum + (m.liquidity || 0), 0) / markets.length;
      const avgSpread = markets.reduce((sum, m) => sum + (m.spread || 0), 0) / markets.length;

      // Aggregate sentiment analysis
      const sentimentCounts = { bullish: 0, bearish: 0, neutral: 0, extreme: 0 };
      const volatilityCounts = { high: 0, moderate: 0, low: 0 };
      for (const m of markets) {
        const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
        const yesPrice = yesToken?.price ?? 0.5;
        const vol = m.volume_num || 0;
        const liq = m.liquidity || 1;
        const ratio = vol / liq;

        if (yesPrice >= 0.85 || yesPrice <= 0.15) sentimentCounts.extreme++;
        else if (yesPrice >= 0.55) sentimentCounts.bullish++;
        else if (yesPrice <= 0.45) sentimentCounts.bearish++;
        else sentimentCounts.neutral++;

        if (ratio > 20 || (m.spread || 0) > 0.05) volatilityCounts.high++;
        else if (ratio < 5 && (m.spread || 0) < 0.025) volatilityCounts.low++;
        else volatilityCounts.moderate++;
      }

      // Determine if single market for deep analysis
      const isSingleMarket = markets.length === 1;
      const wantsDeepAnalysis = text.toLowerCase().includes('detail') ||
                                text.toLowerCase().includes('deep') ||
                                text.toLowerCase().includes('analysis') ||
                                isSingleMarket;

      // Format markets - use comprehensive format for single/deep, brief for lists
      let formattedMarkets: string[];
      if (wantsDeepAnalysis && markets.length <= 3) {
        // For 1-3 markets with deep analysis request, generate LLM-powered insights
        formattedMarkets = [];
        for (let i = 0; i < markets.length; i++) {
          const m = markets[i];
          const baseFormat = formatMarketDetailed(m, i + 1, true);

          // For single market, add AI-generated deep analysis
          if (isSingleMarket) {
            const deepAnalysis = await generateDeepAnalysis(runtime, m, detectedCategory || undefined);
            formattedMarkets.push(`${baseFormat}\n\n   AI-POWERED DEEP ANALYSIS:\n   ${deepAnalysis.split('\n').join('\n   ')}`);
          } else {
            formattedMarkets.push(baseFormat);
          }
        }
      } else {
        // For multiple markets, use detailed format but not deep analysis
        formattedMarkets = markets.map((m, i) => formatMarketDetailed(m, i + 1, true));
      }

      // Build comprehensive response header with market intelligence overview
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

      // Generate sector insight based on category
      let sectorInsight = '';
      if (detectedCategory) {
        const catUpper = detectedCategory.toUpperCase();
        if (sentimentCounts.bullish > sentimentCounts.bearish * 2) {
          sectorInsight = `${catUpper} sector showing strong bullish bias - ${sentimentCounts.bullish}/${markets.length} markets favor YES outcomes. Consider contrarian NO positions in overbought markets.`;
        } else if (sentimentCounts.bearish > sentimentCounts.bullish * 2) {
          sectorInsight = `${catUpper} sector leaning bearish - ${sentimentCounts.bearish}/${markets.length} markets favor NO. Look for YES value plays in oversold conditions.`;
        } else if (sentimentCounts.neutral > markets.length / 2) {
          sectorInsight = `${catUpper} sector highly contested - ${sentimentCounts.neutral}/${markets.length} markets in coin-flip territory. High uncertainty means potential for sharp moves on catalysts.`;
        } else {
          sectorInsight = `${catUpper} sector showing mixed signals. Selective positioning recommended based on individual market analysis.`;
        }
      } else {
        sectorInsight = `Cross-sector sample showing ${sentimentCounts.bullish} bullish, ${sentimentCounts.bearish} bearish, ${sentimentCounts.neutral} contested markets.`;
      }

      // Liquidity assessment
      let liquidityInsight = '';
      if (avgLiquidity > 100000) {
        liquidityInsight = `Excellent market depth (avg $${(avgLiquidity / 1000).toFixed(0)}K liquidity) - suitable for institutional-size positions.`;
      } else if (avgLiquidity > 30000) {
        liquidityInsight = `Good liquidity conditions (avg $${(avgLiquidity / 1000).toFixed(0)}K) - retail and small institutional positions viable.`;
      } else {
        liquidityInsight = `Thin liquidity (avg $${(avgLiquidity / 1000).toFixed(0)}K) - use limit orders and smaller position sizes.`;
      }

      // Volatility assessment
      let volatilityInsight = '';
      if (volatilityCounts.high > markets.length / 2) {
        volatilityInsight = `High volatility environment - ${volatilityCounts.high}/${markets.length} markets showing elevated activity. Active risk management essential.`;
      } else if (volatilityCounts.low > markets.length / 2) {
        volatilityInsight = `Low volatility regime - stable pricing suggests consensus. Watch for breakout catalysts.`;
      } else {
        volatilityInsight = `Mixed volatility profile across markets. Position sizing should be market-specific.`;
      }

      const header = `================================================================================
ZERACLE MARKET INTELLIGENCE REPORT
================================================================================
Generated: ${timestamp}
Query: ${searchContext}
Markets Analyzed: ${markets.length}

AGGREGATE METRICS:
- Total Volume: ${formatVolume(totalVolume)}
- Average Liquidity: ${formatVolume(avgLiquidity)}
- Average Spread: ${(avgSpread * 100).toFixed(2)}%
- Sentiment Distribution: ${sentimentCounts.bullish} bullish | ${sentimentCounts.bearish} bearish | ${sentimentCounts.neutral} contested | ${sentimentCounts.extreme} extreme

SECTOR OVERVIEW:
${sectorInsight}

LIQUIDITY ASSESSMENT:
${liquidityInsight}

VOLATILITY PROFILE:
${volatilityInsight}

================================================================================
INDIVIDUAL MARKET ANALYSIS
================================================================================

`;

      const responseText = header + formattedMarkets.join('\n\n---\n\n');

      // Content depth validation
      if (responseText.length < MIN_ANALYSIS_CHARS) {
        logger.warn({ length: responseText.length, min: MIN_ANALYSIS_CHARS },
          '[ViewMarkets] Response below minimum content depth');
      }

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
