/**
 * Comprehensive Analysis Formatter
 *
 * Formats market analysis with multi-section output for deeper insights.
 * Provides structured, detailed analysis for both UI display and Twitter posts.
 */

import type { PolymarketMarket } from '../types';
import type { MarketSignal, NewsItem, TavilySearchResult } from '../services/data-sources';

export interface AnalysisContext {
  market: PolymarketMarket;
  webContext?: {
    summary: string;
    sources: TavilySearchResult[];
    sentiment: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
  };
  newsItems?: NewsItem[];
  signals?: MarketSignal[];
  priceHistory?: { time: Date; price: number }[];
}

export interface FormattedAnalysis {
  overview: string;
  keyFactors: string[];
  priceAnalysis: string;
  newsContext: string;
  riskAssessment: string;
  recommendation: string;
  fullText: string;
  tweetText: string;
}

/**
 * Format comprehensive market analysis
 */
export function formatComprehensiveAnalysis(context: AnalysisContext): FormattedAnalysis {
  const { market, webContext, newsItems, signals } = context;

  // Calculate key metrics
  const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const yesPrice = yesToken?.price ?? 0.5;
  const volume = market.volume_num || 0;
  const liquidity = market.liquidity || 0;
  const spread = market.spread || 0;

  // Volume tier
  const volumeTier = volume > 1000000 ? 'Very High' :
                     volume > 100000 ? 'High' :
                     volume > 10000 ? 'Medium' : 'Low';

  // Liquidity assessment
  const liquidityAssessment = liquidity > 50000 ? 'Deep liquidity - good for larger positions' :
                              liquidity > 10000 ? 'Moderate liquidity - suitable for medium positions' :
                              'Thin liquidity - limit order recommended';

  // Time to expiry
  let timeToExpiry = 'Unknown';
  let expiryWarning = '';
  if (market.end_date_iso) {
    const endDate = new Date(market.end_date_iso);
    const now = new Date();
    const hoursRemaining = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursRemaining < 0) {
      timeToExpiry = 'Expired';
      expiryWarning = 'Market has expired';
    } else if (hoursRemaining < 24) {
      timeToExpiry = `${Math.round(hoursRemaining)} hours`;
      expiryWarning = 'Expires soon - higher resolution risk';
    } else if (hoursRemaining < 168) {
      timeToExpiry = `${Math.round(hoursRemaining / 24)} days`;
    } else if (hoursRemaining < 720) {
      timeToExpiry = `${Math.round(hoursRemaining / 168)} weeks`;
    } else {
      timeToExpiry = `${Math.round(hoursRemaining / 720)} months`;
    }
  }

  // Build overview
  const overview = `"${market.question}"

Current Price: ${(yesPrice * 100).toFixed(1)}% YES / ${((1 - yesPrice) * 100).toFixed(1)}% NO
Volume: $${formatVolume(volume)} (${volumeTier})
Liquidity: $${formatVolume(liquidity)}
Spread: ${(spread * 100).toFixed(2)}%
Time to Resolution: ${timeToExpiry}`;

  // Key factors
  const keyFactors: string[] = [];

  // Add web context factors
  if (webContext) {
    keyFactors.push(`Web Sentiment: ${webContext.sentiment.toUpperCase()} (${webContext.confidence}% confidence)`);
    if (webContext.sources.length > 0) {
      keyFactors.push(`Top Source: ${webContext.sources[0].title}`);
    }
  }

  // Add signal factors
  if (signals && signals.length > 0) {
    const strongSignals = signals.filter(s => s.strength >= 70);
    if (strongSignals.length > 0) {
      keyFactors.push(`Strong Signals: ${strongSignals.length} detected (${strongSignals.map(s => s.source).join(', ')})`);
    }

    const bullishCount = signals.filter(s => s.direction === 'bullish').length;
    const bearishCount = signals.filter(s => s.direction === 'bearish').length;
    if (bullishCount > bearishCount) {
      keyFactors.push(`Signal Direction: Bullish bias (${bullishCount} bullish vs ${bearishCount} bearish)`);
    } else if (bearishCount > bullishCount) {
      keyFactors.push(`Signal Direction: Bearish bias (${bearishCount} bearish vs ${bullishCount} bullish)`);
    } else {
      keyFactors.push(`Signal Direction: Mixed signals`);
    }
  }

  // Volume factor
  if (volume > 500000) {
    keyFactors.push('High institutional interest indicated by volume');
  }

  // Spread factor
  if (spread < 0.02) {
    keyFactors.push('Tight spread indicates efficient market');
  } else if (spread > 0.05) {
    keyFactors.push('Wide spread - consider limit orders');
  }

  // Price analysis
  const priceAnalysis = generatePriceAnalysis(yesPrice, spread, volumeTier, webContext?.sentiment);

  // News context
  let newsContext = 'No recent news available for this market.';
  if (newsItems && newsItems.length > 0) {
    const recentNews = newsItems.slice(0, 3);
    newsContext = `Recent Related News:\n${recentNews.map((n, i) =>
      `${i + 1}. ${n.title} (${n.source})`
    ).join('\n')}`;
  } else if (webContext?.sources.length) {
    newsContext = `Web Sources:\n${webContext.sources.slice(0, 3).map((s, i) =>
      `${i + 1}. ${s.title}`
    ).join('\n')}`;
  }

  // Risk assessment
  const riskAssessment = generateRiskAssessment(
    yesPrice,
    spread,
    liquidity,
    timeToExpiry,
    expiryWarning
  );

  // Recommendation
  const recommendation = generateRecommendation(
    yesPrice,
    spread,
    volumeTier,
    webContext?.sentiment,
    timeToExpiry
  );

  // Full text compilation
  const fullText = `MARKET ANALYSIS
===============
${overview}

KEY FACTORS
-----------
${keyFactors.map(f => `• ${f}`).join('\n')}

PRICE ANALYSIS
--------------
${priceAnalysis}

NEWS & CONTEXT
--------------
${newsContext}

RISK ASSESSMENT
---------------
${riskAssessment}

RECOMMENDATION
--------------
${recommendation}`;

  // Generate tweet text (concise version)
  const tweetText = generateTweetSummary(
    market.question,
    yesPrice,
    volumeTier,
    webContext?.sentiment,
    recommendation
  );

  return {
    overview,
    keyFactors,
    priceAnalysis,
    newsContext,
    riskAssessment,
    recommendation,
    fullText,
    tweetText,
  };
}

/**
 * Generate price analysis text
 */
function generatePriceAnalysis(
  yesPrice: number,
  spread: number,
  volumeTier: string,
  sentiment?: 'bullish' | 'bearish' | 'neutral'
): string {
  const lines: string[] = [];

  // Price interpretation
  if (yesPrice >= 0.9) {
    lines.push('Market strongly expects YES outcome.');
    lines.push('Limited upside potential, significant downside risk if outcome is NO.');
  } else if (yesPrice >= 0.7) {
    lines.push('Market leans YES but not certain.');
    lines.push('Potential value in NO if you have contrarian edge.');
  } else if (yesPrice >= 0.5) {
    lines.push('Market is moderately confident in YES.');
    lines.push('Balanced risk-reward on either side.');
  } else if (yesPrice >= 0.3) {
    lines.push('Market leans NO but uncertainty remains.');
    lines.push('YES has asymmetric upside if sentiment shifts.');
  } else {
    lines.push('Market strongly expects NO outcome.');
    lines.push('YES is a longshot bet with high potential return.');
  }

  // Sentiment alignment
  if (sentiment) {
    const priceDirection = yesPrice > 0.5 ? 'bullish' : 'bearish';
    if (sentiment === priceDirection) {
      lines.push(`Web sentiment aligns with market price (${sentiment}).`);
    } else if (sentiment !== 'neutral') {
      lines.push(`Sentiment divergence: Web is ${sentiment} while price suggests ${priceDirection}.`);
    }
  }

  // Trading conditions
  if (volumeTier === 'Very High' || volumeTier === 'High') {
    lines.push('Active trading provides good price discovery.');
  } else if (volumeTier === 'Low') {
    lines.push('Low volume may indicate stale pricing or lack of interest.');
  }

  return lines.join('\n');
}

/**
 * Generate risk assessment
 */
function generateRiskAssessment(
  yesPrice: number,
  spread: number,
  liquidity: number,
  timeToExpiry: string,
  expiryWarning: string
): string {
  const risks: string[] = [];

  // Expiry risk
  if (expiryWarning) {
    risks.push(`⚠ ${expiryWarning}`);
  }

  // Liquidity risk
  if (liquidity < 5000) {
    risks.push('⚠ Low liquidity - may be difficult to exit position');
  }

  // Spread risk
  if (spread > 0.05) {
    risks.push('⚠ Wide spread - significant cost to enter/exit');
  }

  // Price extremity risk
  if (yesPrice > 0.95 || yesPrice < 0.05) {
    risks.push('⚠ Extreme price - small edge, large potential loss on wrong outcome');
  }

  // Time-based risks
  if (timeToExpiry.includes('hour')) {
    risks.push('⚠ Short time to resolution - higher information asymmetry risk');
  }

  if (risks.length === 0) {
    return 'No significant red flags identified. Standard prediction market risks apply.';
  }

  return risks.join('\n');
}

/**
 * Generate recommendation
 */
function generateRecommendation(
  yesPrice: number,
  spread: number,
  volumeTier: string,
  sentiment?: 'bullish' | 'bearish' | 'neutral',
  timeToExpiry?: string
): string {
  // Edge detection
  const hasPositiveEdge = sentiment && (
    (sentiment === 'bullish' && yesPrice < 0.6) ||
    (sentiment === 'bearish' && yesPrice > 0.4)
  );

  // Market quality
  const isQualityMarket = (volumeTier === 'High' || volumeTier === 'Very High') && spread < 0.05;

  let recommendation = '';

  if (hasPositiveEdge && isQualityMarket) {
    const direction = sentiment === 'bullish' ? 'YES' : 'NO';
    recommendation = `Potential opportunity: Consider ${direction} position. `;
    recommendation += `Sentiment-price divergence suggests possible mispricing. `;
    recommendation += `Good market conditions for execution.`;
  } else if (hasPositiveEdge) {
    const direction = sentiment === 'bullish' ? 'YES' : 'NO';
    recommendation = `Possible edge on ${direction} side, but use limit orders due to spread/liquidity.`;
  } else if (isQualityMarket) {
    recommendation = `Liquid market with tight spread. No clear edge from current signals. `;
    recommendation += `Monitor for catalyst-driven opportunities.`;
  } else {
    recommendation = `No clear trading opportunity at current prices. `;
    recommendation += `Watch for sentiment shifts or improved market conditions.`;
  }

  // Size guidance
  if (yesPrice > 0.9 || yesPrice < 0.1) {
    recommendation += '\n\nPosition sizing: Reduce size due to extreme odds.';
  } else if (hasPositiveEdge) {
    recommendation += '\n\nPosition sizing: Standard Kelly fraction (25-50% of full Kelly).';
  }

  return recommendation;
}

/**
 * Generate tweet-length summary
 */
function generateTweetSummary(
  question: string,
  yesPrice: number,
  volumeTier: string,
  sentiment?: 'bullish' | 'bearish' | 'neutral',
  recommendation?: string
): string {
  const shortQuestion = question.length > 80 ? question.slice(0, 77) + '...' : question;
  const priceStr = `${(yesPrice * 100).toFixed(0)}%`;

  let summary = `"${shortQuestion}"\n\n`;
  summary += `Current: ${priceStr} YES | Volume: ${volumeTier}\n`;

  if (sentiment && sentiment !== 'neutral') {
    summary += `Web sentiment: ${sentiment.toUpperCase()}\n`;
  }

  // Keep under 280 chars
  if (summary.length > 260) {
    summary = summary.slice(0, 257) + '...';
  }

  return summary;
}

/**
 * Format volume for display
 */
function formatVolume(volume: number): string {
  if (volume >= 1000000) {
    return `${(volume / 1000000).toFixed(1)}M`;
  } else if (volume >= 1000) {
    return `${(volume / 1000).toFixed(0)}K`;
  }
  return volume.toFixed(0);
}

export default {
  formatComprehensiveAnalysis,
};
