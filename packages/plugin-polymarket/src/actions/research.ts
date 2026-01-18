/**
 * Research Markets Action
 *
 * Allows the agent to research specific topics, sectors, or events
 * and find related markets with relevant news and signals.
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
import { MarketIntelligenceService } from '../services/market-intelligence';
import { DataSourcesService, type NewsItem, type CryptoPrice, type MarketSignal } from '../services/data-sources';
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
 * Map topic to data source category
 */
function mapTopicToCategory(topic: string): 'crypto' | 'politics' | 'economy' | 'sports' | 'geopolitics' | 'tech' | null {
  const lowerTopic = topic.toLowerCase();
  if (['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'defi', 'blockchain', 'token'].some(k => lowerTopic.includes(k))) {
    return 'crypto';
  }
  if (['politics', 'election', 'president', 'congress', 'senate', 'vote', 'democrat', 'republican'].some(k => lowerTopic.includes(k))) {
    return 'politics';
  }
  if (['finance', 'economy', 'fed', 'interest', 'inflation', 'stock', 'gdp', 'market'].some(k => lowerTopic.includes(k))) {
    return 'economy';
  }
  if (['sports', 'nfl', 'nba', 'mlb', 'football', 'basketball', 'super bowl', 'championship'].some(k => lowerTopic.includes(k))) {
    return 'sports';
  }
  if (['world', 'ukraine', 'russia', 'china', 'war', 'international', 'geopolitics'].some(k => lowerTopic.includes(k))) {
    return 'geopolitics';
  }
  if (['tech', 'ai', 'technology', 'apple', 'google', 'microsoft', 'openai'].some(k => lowerTopic.includes(k))) {
    return 'tech';
  }
  return null;
}

/**
 * Synthesize insights from news and market data
 */
function synthesizeInsights(news: NewsItem[], signals: MarketSignal[], cryptoPrices: CryptoPrice[]): {
  summary: string;
  sentiment: 'bullish' | 'bearish' | 'mixed' | 'neutral';
  keyPoints: string[];
  priceContext: string;
} {
  // Analyze sentiment distribution
  let bullishCount = 0;
  let bearishCount = 0;

  for (const n of news) {
    if (n.sentiment === 'positive') bullishCount++;
    else if (n.sentiment === 'negative') bearishCount++;
  }

  for (const s of signals) {
    if (s.direction === 'bullish') bullishCount++;
    else if (s.direction === 'bearish') bearishCount++;
  }

  const total = bullishCount + bearishCount;
  let sentiment: 'bullish' | 'bearish' | 'mixed' | 'neutral' = 'neutral';
  if (total > 0) {
    const bullishRatio = bullishCount / total;
    if (bullishRatio > 0.65) sentiment = 'bullish';
    else if (bullishRatio < 0.35) sentiment = 'bearish';
    else if (total >= 3) sentiment = 'mixed';
  }

  // Extract key points from top news
  const keyPoints: string[] = [];
  const topNews = news.slice(0, 5);
  for (const n of topNews) {
    if (n.title && n.title.length > 20) {
      keyPoints.push(sanitizeText(n.title).slice(0, 80));
    }
  }

  // Build price context for crypto
  let priceContext = '';
  if (cryptoPrices.length > 0) {
    const priceLines = cryptoPrices.slice(0, 3).map(p => {
      const direction = p.change24h >= 0 ? '+' : '';
      return `${p.symbol}: $${p.price.toLocaleString()} (${direction}${p.change24h.toFixed(1)}% 24h)`;
    });
    priceContext = priceLines.join(' | ');
  }

  // Generate summary
  const newsCount = news.length;
  const signalCount = signals.filter(s => s.strength >= 60).length;
  const summary = `${newsCount} relevant news items, ${signalCount} strong signals. Overall sentiment: ${sentiment.toUpperCase()}.`;

  return { summary, sentiment, keyPoints, priceContext };
}

/**
 * Format volume for display
 */
function formatVolume(volume: number | undefined | null): string {
  if (!volume && volume !== 0) return '$0';
  if (volume >= 1000000) return `$${(volume / 1000000).toFixed(1)}M`;
  if (volume >= 1000) return `$${(volume / 1000).toFixed(0)}K`;
  return `$${volume.toFixed(0)}`;
}

export const researchMarketsAction: Action = {
  name: 'RESEARCH_MARKETS',
  similes: [
    'ANALYZE_SECTOR',
    'RESEARCH_TOPIC',
    'INVESTIGATE_MARKETS',
    'EXPLORE_MARKETS',
    'SECTOR_ANALYSIS',
    'TOPIC_RESEARCH',
  ],
  description: 'Research a specific topic, sector, or event to find related prediction markets and opportunities',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    const researchKeywords = ['research', 'analyze', 'investigate', 'explore', 'look into', 'dig into', 'study'];
    const topicIndicators = ['about', 'on', 'regarding', 'for', 'related to', 'sector', 'topic', 'area'];

    const hasResearchIntent = researchKeywords.some(k => text.includes(k));
    const hasTopicContext = topicIndicators.some(k => text.includes(k));

    // Also trigger on category mentions
    const categories = ['politics', 'crypto', 'sports', 'finance', 'tech', 'world', 'entertainment'];
    const hasCategoryMention = categories.some(c => text.includes(c));

    return hasResearchIntent || (hasTopicContext && hasCategoryMention);
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
      const polymarketService = runtime.getService<PolymarketService>('polymarket');
      const intelligenceService = runtime.getService<MarketIntelligenceService>('market-intelligence');
      const dataSourcesService = runtime.getService<DataSourcesService>('data-sources');

      if (!polymarketService) {
        const errorMsg = 'Polymarket service not available.';
        if (callback) await callback({ text: errorMsg, error: true });
        return { success: false, error: errorMsg };
      }

      // Extract topic from message
      const text = message.content.text || '';
      let topic = '';

      // Try to extract quoted topic
      const quotedMatch = text.match(/"([^"]+)"/);
      if (quotedMatch) {
        topic = quotedMatch[1];
      } else {
        // Extract topic after research keywords
        const patterns = [
          /(?:research|analyze|investigate|explore|look into|dig into|study)\s+(?:the\s+)?(.+?)(?:\?|$|markets?|sector)/i,
          /(?:about|on|regarding|for|related to)\s+(.+?)(?:\?|$|markets?)/i,
        ];

        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            topic = match[1].trim();
            break;
          }
        }
      }

      // Check for category keywords
      const categories = ['politics', 'crypto', 'sports', 'finance', 'tech', 'world', 'entertainment'];
      const foundCategory = categories.find(c => text.toLowerCase().includes(c));
      if (!topic && foundCategory) {
        topic = foundCategory;
      }

      if (!topic) {
        const noTopicMsg = 'What topic or sector would you like me to research? Examples: "research crypto markets", "analyze politics sector", "investigate AI predictions"';
        if (callback) await callback({ text: noTopicMsg });
        return { success: true, text: noTopicMsg, data: {} };
      }

      const etTime = getCurrentETTime();
      const dataCategory = mapTopicToCategory(topic);

      if (callback) {
        await callback({
          text: `Researching "${sanitizeText(topic)}" - gathering multi-source intelligence... (${etTime.dateStr} ${etTime.timeStr} ET)`,
        });
      }

      // Parallel fetch: markets, opportunities, and external data
      const [opportunities, categoryMarkets, topicMarkets] = await Promise.all([
        intelligenceService ? intelligenceService.researchTopic(topic) : Promise.resolve([]),
        polymarketService.getMarketsByCategory(topic, 10),
        polymarketService.findMarketsForTopic(topic, 10),
      ]);

      // Fetch external data from multiple sources based on topic category
      let news: NewsItem[] = [];
      let cryptoPrices: CryptoPrice[] = [];
      let marketSignals: MarketSignal[] = [];

      if (dataSourcesService) {
        try {
          // Fetch data based on topic category
          if (dataCategory === 'crypto') {
            [news, cryptoPrices, marketSignals] = await Promise.all([
              dataSourcesService.getCryptoNews('hot'),
              dataSourcesService.getCryptoPrices(['bitcoin', 'ethereum', 'solana', 'cardano']),
              dataSourcesService.getMarketSignals(),
            ]);
          } else if (dataCategory) {
            [news, marketSignals] = await Promise.all([
              dataSourcesService.getNewsByCategory(dataCategory as 'politics' | 'economy' | 'sports' | 'geopolitics' | 'tech'),
              dataSourcesService.getMarketSignals(),
            ]);
          } else {
            // General fetch
            [news, marketSignals] = await Promise.all([
              dataSourcesService.getAllNews().then(n => n.slice(0, 20)),
              dataSourcesService.getMarketSignals(),
            ]);
          }
        } catch (error) {
          logger.warn({ error }, '[ResearchMarketsAction] External data fetch failed, continuing with market data');
        }
      }

      // Combine and dedupe markets
      const allMarkets = new Map();
      for (const m of [...categoryMarkets, ...topicMarkets]) {
        if (!allMarkets.has(m.condition_id)) {
          allMarkets.set(m.condition_id, m);
        }
      }

      const markets = Array.from(allMarkets.values()).slice(0, 10);

      if (markets.length === 0 && opportunities.length === 0) {
        const noResultsMsg = `No active markets found for "${sanitizeText(topic)}". Try a broader search term or different category.`;
        if (callback) await callback({ text: noResultsMsg });
        return { success: true, text: noResultsMsg, data: { markets: [] } };
      }

      // Synthesize insights from all data sources
      const insights = synthesizeInsights(news, marketSignals, cryptoPrices);

      // Build comprehensive research report
      let responseText = `RESEARCH REPORT: "${sanitizeText(topic)}"\n`;
      responseText += `Generated: ${etTime.dateStr} ${etTime.timeStr} ET\n`;
      responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      // Intelligence Summary
      responseText += `INTELLIGENCE SUMMARY\n`;
      responseText += `${insights.summary}\n`;
      if (insights.priceContext) {
        responseText += `Price Context: ${insights.priceContext}\n`;
      }
      responseText += `\n`;

      // Key Headlines
      if (insights.keyPoints.length > 0) {
        responseText += `KEY HEADLINES (${news.length} sources analyzed):\n`;
        for (const point of insights.keyPoints.slice(0, 4)) {
          responseText += `- ${point}\n`;
        }
        responseText += `\n`;
      }

      // Top Opportunities
      if (opportunities.length > 0) {
        responseText += `TOP OPPORTUNITIES (${opportunities.length} identified):\n`;
        for (const opp of opportunities.slice(0, 3)) {
          const yesPrice = opp.market.tokens.find((t: { outcome: string; price: number }) => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
          const vol = formatVolume(opp.market.volume_num || 0);
          responseText += `  "${sanitizeText(opp.market.question.slice(0, 55))}..."\n`;
          responseText += `   Odds: YES ${(yesPrice * 100).toFixed(0)}% | Signal Score: ${opp.score}/100 | Vol: ${vol}\n`;
          responseText += `   Direction: ${opp.direction.toUpperCase()} | News: ${opp.newsItems.length} items | ${opp.timeContext}\n`;
        }
        responseText += `\n`;
      }

      // Related Markets
      responseText += `RELATED MARKETS (${markets.length} active):\n`;
      for (const market of markets.slice(0, 5)) {
        const yesToken = market.tokens.find((t: { outcome: string; price: number }) => t.outcome.toLowerCase() === 'yes');
        const noToken = market.tokens.find((t: { outcome: string; price: number }) => t.outcome.toLowerCase() === 'no');
        const yesPrice = yesToken?.price || 0.5;
        const noPrice = noToken?.price || 0.5;
        const vol = formatVolume(market.volume_num || 0);
        const liq = formatVolume(market.liquidity || 0);

        // Determine market sentiment
        let marketSentiment = 'neutral';
        if (yesPrice >= 0.65) marketSentiment = 'bullish';
        else if (yesPrice <= 0.35) marketSentiment = 'bearish';

        responseText += `  "${sanitizeText(market.question.slice(0, 60))}"\n`;
        responseText += `   YES: ${(yesPrice * 100).toFixed(0)}% / NO: ${(noPrice * 100).toFixed(0)}% | Vol: ${vol} | Liq: ${liq} | ${marketSentiment}\n`;
      }

      // Trading Implications
      responseText += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      responseText += `TRADING IMPLICATIONS:\n`;
      if (insights.sentiment === 'bullish') {
        responseText += `Overall sentiment is BULLISH - consider YES positions on high-conviction markets.\n`;
      } else if (insights.sentiment === 'bearish') {
        responseText += `Overall sentiment is BEARISH - consider NO positions or hedging strategies.\n`;
      } else if (insights.sentiment === 'mixed') {
        responseText += `Sentiment is MIXED - focus on individual market catalysts and use smaller position sizes.\n`;
      } else {
        responseText += `Sentiment is NEUTRAL - wait for clearer signals before taking positions.\n`;
      }
      responseText += `\nTIP: Ask "market details [market name]" for in-depth analysis on specific markets.`;

      if (callback) {
        await callback({
          text: sanitizeText(responseText),
          action: 'RESEARCH_MARKETS',
        });
      }

      return {
        success: true,
        text: sanitizeText(responseText),
        data: {
          topic,
          category: dataCategory,
          insights: {
            sentiment: insights.sentiment,
            newsCount: news.length,
            signalCount: marketSignals.length,
            keyPoints: insights.keyPoints,
          },
          markets: markets.map(m => ({
            conditionId: m.condition_id,
            question: m.question,
            yesPrice: m.tokens.find((t: { outcome: string; price: number }) => t.outcome.toLowerCase() === 'yes')?.price,
            volume: m.volume_num,
            liquidity: m.liquidity,
          })),
          opportunities: opportunities.slice(0, 5).map((o: { market: { condition_id: string }; score: number; direction: string; newsItems: unknown[] }) => ({
            marketId: o.market.condition_id,
            score: o.score,
            direction: o.direction,
            newsCount: o.newsItems.length,
          })),
          cryptoPrices: cryptoPrices.map(p => ({
            symbol: p.symbol,
            price: p.price,
            change24h: p.change24h,
          })),
        },
      };
    } catch (error) {
      const errorMsg = `Research failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[ResearchMarketsAction] Error');

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
          text: 'Research crypto markets',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'RESEARCH REPORT: "crypto"\nGenerated: 2026-01-02 10:30 AM ET\n\nINTELLIGENCE SUMMARY\n12 relevant news items, 5 strong signals. Overall sentiment: BULLISH.\nPrice Context: BTC: $98,500 (+2.3% 24h) | ETH: $3,850 (+1.8% 24h)\n\nKEY HEADLINES:\n- Bitcoin ETF inflows hit record $1.2B in single day\n- Ethereum L2 TVL reaches new all-time high\n\nTOP OPPORTUNITIES:\n  "Will Bitcoin reach $150k in 2026?"\n   Odds: YES 45% | Signal Score: 78/100 | Vol: $2.5M\n   Direction: BULLISH | News: 5 items | 180 days\n\nRELATED MARKETS:\n  "ETH above $6k by March?"\n   YES: 35% / NO: 65% | Vol: $1.2M | Liq: $450K | bearish\n\nTRADING IMPLICATIONS:\nOverall sentiment is BULLISH - consider YES positions on high-conviction markets.',
          action: 'RESEARCH_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'Analyze the politics sector',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'RESEARCH REPORT: "politics"\nGenerated: 2026-01-02 10:30 AM ET\n\nINTELLIGENCE SUMMARY\n8 relevant news items, 3 strong signals. Overall sentiment: MIXED.\n\nKEY HEADLINES:\n- Congress passes bipartisan infrastructure bill\n- Approval ratings shift ahead of midterms\n\nRELATED MARKETS:\n  "2026 Midterm - Which party controls House?"\n   YES: 52% / NO: 48% | Vol: $4.5M | Liq: $1.2M | neutral\n  "Next Supreme Court vacancy before 2028?"\n   YES: 28% / NO: 72% | Vol: $850K | Liq: $180K | bearish\n\nTRADING IMPLICATIONS:\nSentiment is MIXED - focus on individual market catalysts and use smaller position sizes.',
          action: 'RESEARCH_MARKETS',
        },
      },
    ],
  ],
};
