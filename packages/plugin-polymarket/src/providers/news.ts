/**
 * News Provider for Polymarket Trading
 *
 * Gathers relevant news and market intelligence for prediction market analysis.
 * Uses web search to find recent news related to active markets.
 */

import type { Provider, IAgentRuntime, Memory, State, Service } from '@elizaos/core';
import { logger, ServiceType } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';

// Define types inline to avoid import issues
interface SearchResult {
  title: string;
  url: string;
  description: string;
  publishedDate?: Date;
  source?: string;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
}

interface IWebSearchServiceLike extends Service {
  searchNews(query: string, options?: { limit?: number; freshness?: string }): Promise<SearchResponse>;
}

interface NewsItem {
  market: string;
  headlines: Array<{
    title: string;
    source: string;
    summary: string;
    url: string;
  }>;
}

/**
 * Extract key topics from market questions for news search
 */
function extractSearchTerms(marketQuestion: string): string[] {
  // Remove common prediction market phrases
  const cleaned = marketQuestion
    .replace(/Will\s+/gi, '')
    .replace(/\s+by\s+\d{4}/gi, '')
    .replace(/\s+before\s+\d{4}/gi, '')
    .replace(/\s+in\s+\d{4}/gi, '')
    .replace(/\?$/g, '');

  // Extract key entities and topics
  const terms: string[] = [];

  // Common patterns in prediction markets
  const patterns = [
    /(?:Trump|Biden|Harris|DeSantis|Obama|Clinton)/gi, // Politicians
    /(?:Bitcoin|Ethereum|Crypto|BTC|ETH)/gi, // Crypto
    /(?:Fed|Federal Reserve|interest rate|inflation)/gi, // Economics
    /(?:SpaceX|Tesla|Apple|Google|Microsoft|Amazon)/gi, // Companies
    /(?:Ukraine|Russia|China|Israel|Gaza)/gi, // Geopolitics
    /(?:election|vote|primary|nominee)/gi, // Elections
    /(?:Super Bowl|World Cup|Olympics|NBA|NFL)/gi, // Sports
  ];

  for (const pattern of patterns) {
    const matches = cleaned.match(pattern);
    if (matches) {
      terms.push(...matches);
    }
  }

  // If no specific patterns matched, use the cleaned question
  if (terms.length === 0) {
    terms.push(cleaned.slice(0, 100));
  }

  return [...new Set(terms)]; // Deduplicate
}

/**
 * News provider that gathers market-relevant news
 */
export const newsProvider: Provider = {
  name: 'polymarket-news',
  description: 'Provides recent news and market intelligence for Polymarket prediction markets',

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<string> => {
    try {
      // Get Polymarket service
      const polymarketService = runtime.getService<PolymarketService>('polymarket');
      if (!polymarketService) {
        return 'News provider: Polymarket service not available';
      }

      // Get web search service (optional)
      const webSearchService = runtime.getService(ServiceType.WEB_SEARCH) as IWebSearchServiceLike | undefined;

      // Get active markets
      const markets = await polymarketService.getMarkets(5); // Top 5 markets
      if (!markets || markets.length === 0) {
        return 'News provider: No active markets to analyze';
      }

      const newsItems: NewsItem[] = [];

      // If we have web search, gather news for each market
      if (webSearchService) {
        for (const market of markets.slice(0, 3)) { // Limit to 3 to avoid rate limits
          const searchTerms = extractSearchTerms(market.question);
          const query = searchTerms.join(' ') + ' latest news';

          try {
            const searchResults = await webSearchService.searchNews(query, {
              limit: 3,
              freshness: 'day',
            });

            if (searchResults?.results?.length > 0) {
              newsItems.push({
                market: market.question,
                headlines: searchResults.results.map((r) => ({
                  title: r.title,
                  source: r.source || 'Unknown',
                  summary: r.description,
                  url: r.url,
                })),
              });
            }
          } catch (error) {
            logger.debug({ error, market: market.question }, '[NewsProvider] Failed to fetch news for market');
          }
        }
      }

      // Build news context
      let newsContext = '## Recent News & Market Intelligence\n\n';

      if (newsItems.length > 0) {
        for (const item of newsItems) {
          newsContext += `### ${item.market}\n`;
          for (const headline of item.headlines) {
            newsContext += `- **${headline.title}** (${headline.source})\n`;
            newsContext += `  ${headline.summary}\n`;
          }
          newsContext += '\n';
        }
      } else {
        // If no web search available, provide general market context
        newsContext += 'Web search not available. Analyze markets based on:\n';
        newsContext += '- Current market prices and implied probabilities\n';
        newsContext += '- Historical price movements\n';
        newsContext += '- Market volume and liquidity\n';
        newsContext += '- Time until resolution\n\n';

        // Include market data
        newsContext += '### Active Markets:\n';
        for (const market of markets) {
          const yesPrice = market.tokens.find((t) => t.outcome === 'Yes')?.price || 0;
          newsContext += `- **${market.question}**\n`;
          newsContext += `  Current YES: ${(yesPrice * 100).toFixed(1)}% | Volume: $${market.volume?.toLocaleString() || 'N/A'}\n`;
        }
      }

      return newsContext;
    } catch (error) {
      logger.error({ error }, '[NewsProvider] Failed to gather news');
      return 'News provider: Error gathering market intelligence';
    }
  },
};
