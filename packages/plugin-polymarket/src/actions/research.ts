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

      if (callback) {
        await callback({
          text: `Researching "${sanitizeText(topic)}" markets... (${etTime.dateStr} ${etTime.timeStr} ET)`,
        });
      }

      // Use intelligence service if available for deeper analysis
      let opportunities = [];
      if (intelligenceService) {
        opportunities = await intelligenceService.researchTopic(topic);
      }

      // Also get category markets directly
      const categoryMarkets = await polymarketService.getMarketsByCategory(topic, 10);
      const topicMarkets = await polymarketService.findMarketsForTopic(topic, 10);

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

      // Format research results
      let responseText = `Research: "${sanitizeText(topic)}" (${etTime.dateStr})\n\n`;

      // Add opportunity summary if available
      if (opportunities.length > 0) {
        responseText += `TOP OPPORTUNITIES (${opportunities.length} found):\n`;
        for (const opp of opportunities.slice(0, 3)) {
          const yesPrice = opp.market.tokens.find(t => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
          responseText += `- ${sanitizeText(opp.market.question.slice(0, 50))}...\n`;
          responseText += `  YES: ${(yesPrice * 100).toFixed(0)}% | Score: ${opp.score} | ${opp.newsItems.length} news | ${opp.timeContext}\n`;
        }
        responseText += '\n';
      }

      // Add market list
      responseText += `RELATED MARKETS (${markets.length}):\n`;
      for (const market of markets.slice(0, 5)) {
        const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
        const yesPrice = yesToken?.price || 0.5;
        const volume = market.volume_num ? `$${(market.volume_num / 1000).toFixed(0)}k vol` : '';
        responseText += `- ${sanitizeText(market.question.slice(0, 60))}...\n`;
        responseText += `  YES: ${(yesPrice * 100).toFixed(0)}% ${volume}\n`;
      }

      // Add analysis tips
      responseText += `\nTIP: Ask "market details [market name]" for deeper analysis on any market.`;

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
          markets: markets.map(m => ({
            conditionId: m.condition_id,
            question: m.question,
            yesPrice: m.tokens.find(t => t.outcome.toLowerCase() === 'yes')?.price,
            volume: m.volume_num,
          })),
          opportunities: opportunities.slice(0, 5).map(o => ({
            marketId: o.market.condition_id,
            score: o.score,
            direction: o.direction,
            newsCount: o.newsItems.length,
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
          text: 'Research: "crypto" (2026-01-02)\n\nTOP OPPORTUNITIES:\n- Will Bitcoin reach $150k in 2026?... YES: 45% | Score: 78 | 5 news\n\nRELATED MARKETS:\n- ETH above $6k by March?... YES: 35% $120k vol',
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
          text: 'Research: "politics" (2026-01-02)\n\nRELATED MARKETS:\n- 2026 Midterm control?... YES: 52% $450k vol\n- Next Supreme Court vacancy?... YES: 28% $85k vol',
          action: 'RESEARCH_MARKETS',
        },
      },
    ],
  ],
};
