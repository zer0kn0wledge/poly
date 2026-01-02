/**
 * Market Intelligence Service
 *
 * Periodically scans news and data sources, links them to markets,
 * and generates trading opportunities based on information asymmetry.
 *
 * Features:
 * - Periodic news scanning (every 15 minutes)
 * - News-to-market linking using keyword matching
 * - Opportunity scoring based on relevance and market metrics
 * - Historical tracking for strategy learning
 */

import { Service, logger, type IAgentRuntime, ModelType } from '@elizaos/core';
import { getCurrentETTime, isMarketExpired, detectPastYearMarket } from '../providers/timezone';
import { PolymarketService } from './polymarket';
import { DataSourcesService, type NewsItem, type MarketSignal } from './data-sources';
import { StrategyLearningService } from './strategy-learning';
import type { PolymarketMarket } from '../types';

// ============= Types =============

export interface MarketOpportunity {
  id: string;
  market: PolymarketMarket;
  signals: MarketSignal[];
  newsItems: NewsItem[];
  score: number; // 0-100
  direction: 'yes' | 'no' | 'neutral';
  reasoning: string;
  confidence: number;
  timestamp: Date;
  category: string;
  timeContext: string;
}

interface NewsMarketLink {
  newsId: string;
  marketId: string;
  relevanceScore: number;
  keywords: string[];
  timestamp: Date;
}

// ============= Service Implementation =============

export class MarketIntelligenceService extends Service {
  static override readonly serviceType = 'market-intelligence';
  override capabilityDescription = 'Scans news and links to markets for trading opportunities';

  static async start(runtime: IAgentRuntime): Promise<MarketIntelligenceService> {
    const service = new MarketIntelligenceService();
    await service.initialize(runtime);
    return service;
  }

  private runtime: IAgentRuntime | null = null;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private opportunities: Map<string, MarketOpportunity> = new Map();
  private newsMarketLinks: NewsMarketLink[] = [];

  private readonly SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  private readonly MAX_OPPORTUNITIES = 50;
  private readonly MAX_LINKS = 500;

  constructor() {
    super();
  }

  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[MarketIntelligence] Initializing market intelligence service');
    this.runtime = runtime;

    // Start periodic scanning
    this.scanInterval = setInterval(() => {
      this.performIntelligenceScan().catch((error) => {
        logger.error({ error }, '[MarketIntelligence] Scan failed');
      });
    }, this.SCAN_INTERVAL_MS);

    // Do initial scan
    setTimeout(() => {
      this.performIntelligenceScan().catch((error) => {
        logger.error({ error }, '[MarketIntelligence] Initial scan failed');
      });
    }, 30000); // Wait 30s for other services to initialize
  }

  override async stop(): Promise<void> {
    logger.info('[MarketIntelligence] Stopping market intelligence service');
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.opportunities.clear();
    this.newsMarketLinks = [];
  }

  // ============= Main Intelligence Scan =============

  async performIntelligenceScan(): Promise<MarketOpportunity[]> {
    if (!this.runtime) return [];

    const etTime = getCurrentETTime();
    logger.info({ date: etTime.dateStr, time: etTime.timeStr }, '[MarketIntelligence] Starting intelligence scan');

    const polymarketService = this.runtime.getService<PolymarketService>('polymarket');
    const dataSourcesService = this.runtime.getService<DataSourcesService>('data-sources');

    if (!polymarketService || !dataSourcesService) {
      logger.warn('[MarketIntelligence] Required services not available');
      return [];
    }

    try {
      // 1. Fetch fresh news and signals
      const [allNews, signals] = await Promise.all([
        dataSourcesService.getAllNews(),
        dataSourcesService.getMarketSignals(),
      ]);

      logger.debug({ newsCount: allNews.length, signalCount: signals.length }, '[MarketIntelligence] Fetched data');

      // 2. Get markets for different categories
      const categoryMarkets = await this.fetchMarketsByCategory(polymarketService);

      // 3. Link news to markets
      const links = await this.linkNewsToMarkets(allNews, categoryMarkets);
      this.newsMarketLinks = [...links, ...this.newsMarketLinks].slice(0, this.MAX_LINKS);

      // 4. Generate opportunities from linked news
      const opportunities = await this.generateOpportunities(
        links,
        allNews,
        categoryMarkets,
        signals,
        etTime
      );

      // 5. Store opportunities
      for (const opp of opportunities) {
        this.opportunities.set(opp.id, opp);
      }

      // Trim old opportunities
      const sortedOpps = Array.from(this.opportunities.values())
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, this.MAX_OPPORTUNITIES);
      this.opportunities.clear();
      for (const opp of sortedOpps) {
        this.opportunities.set(opp.id, opp);
      }

      logger.info({
        opportunities: opportunities.length,
        totalStored: this.opportunities.size,
        links: this.newsMarketLinks.length,
      }, '[MarketIntelligence] Scan complete');

      return opportunities;
    } catch (error) {
      logger.error({ error }, '[MarketIntelligence] Scan error');
      return [];
    }
  }

  // ============= Market Fetching =============

  private async fetchMarketsByCategory(
    polymarketService: PolymarketService
  ): Promise<Map<string, PolymarketMarket[]>> {
    const categories = ['politics', 'crypto', 'sports', 'finance', 'tech', 'world'];
    const categoryMarkets = new Map<string, PolymarketMarket[]>();

    // Fetch markets for each category in parallel
    const results = await Promise.all(
      categories.map(async (category) => {
        try {
          const markets = await polymarketService.getMarketsByCategory(category, 15);
          return { category, markets };
        } catch (error) {
          logger.warn({ error, category }, '[MarketIntelligence] Category fetch failed');
          return { category, markets: [] };
        }
      })
    );

    for (const { category, markets } of results) {
      categoryMarkets.set(category, markets);
    }

    // Also get trending markets
    try {
      const trending = await polymarketService.getTrendingMarkets({ limit: 20 });
      categoryMarkets.set('trending', trending);
    } catch (error) {
      logger.warn({ error }, '[MarketIntelligence] Trending fetch failed');
    }

    return categoryMarkets;
  }

  // ============= News-to-Market Linking =============

  private async linkNewsToMarkets(
    news: NewsItem[],
    categoryMarkets: Map<string, PolymarketMarket[]>
  ): Promise<NewsMarketLink[]> {
    const links: NewsMarketLink[] = [];

    // Flatten all markets
    const allMarkets: PolymarketMarket[] = [];
    for (const markets of categoryMarkets.values()) {
      allMarkets.push(...markets);
    }

    // Dedupe markets by condition_id
    const uniqueMarkets = new Map<string, PolymarketMarket>();
    for (const market of allMarkets) {
      if (!uniqueMarkets.has(market.condition_id)) {
        uniqueMarkets.set(market.condition_id, market);
      }
    }

    // Link each news item to relevant markets
    for (const newsItem of news.slice(0, 50)) { // Limit to avoid too much processing
      const newsKeywords = this.extractKeywords(newsItem.title + ' ' + newsItem.summary);

      for (const market of uniqueMarkets.values()) {
        const marketKeywords = this.extractKeywords(market.question);
        const commonKeywords = newsKeywords.filter(k => marketKeywords.includes(k));

        if (commonKeywords.length >= 2) { // At least 2 common keywords
          const relevanceScore = Math.min(100, commonKeywords.length * 20);
          links.push({
            newsId: newsItem.id,
            marketId: market.condition_id,
            relevanceScore,
            keywords: commonKeywords,
            timestamp: new Date(),
          });
        }
      }
    }

    return links;
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'will', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'to', 'of', 'in', 'for', 'on',
      'with', 'at', 'by', 'from', 'or', 'and', 'as', 'if', 'but', 'not', 'that',
      'this', 'it', 'its', 'what', 'which', 'who', 'when', 'where', 'why', 'how',
      'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
      'than', 'too', 'very', 'just', 'can', 'could', 'should', 'would', 'may', 'might',
    ]);

    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .filter((word, index, self) => self.indexOf(word) === index); // Dedupe
  }

  // ============= Opportunity Generation =============

  private async generateOpportunities(
    links: NewsMarketLink[],
    news: NewsItem[],
    categoryMarkets: Map<string, PolymarketMarket[]>,
    signals: MarketSignal[],
    etTime: ReturnType<typeof getCurrentETTime>
  ): Promise<MarketOpportunity[]> {
    const opportunities: MarketOpportunity[] = [];
    const newsMap = new Map(news.map(n => [n.id, n]));

    // Group links by market
    const marketLinks = new Map<string, NewsMarketLink[]>();
    for (const link of links) {
      const existing = marketLinks.get(link.marketId) || [];
      existing.push(link);
      marketLinks.set(link.marketId, existing);
    }

    // Get all markets
    const allMarkets = new Map<string, PolymarketMarket>();
    for (const markets of categoryMarkets.values()) {
      for (const market of markets) {
        allMarkets.set(market.condition_id, market);
      }
    }

    // Generate opportunity for markets with multiple news links
    for (const [marketId, marketNewsLinks] of marketLinks.entries()) {
      if (marketNewsLinks.length < 2) continue; // Need at least 2 news items

      const market = allMarkets.get(marketId);
      if (!market) continue;

      // Get related news items
      const relatedNews = marketNewsLinks
        .map(link => newsMap.get(link.newsId))
        .filter(Boolean) as NewsItem[];

      // Get related signals
      const relatedSignals = signals.filter(s =>
        s.relatedMarkets.some(rm =>
          market.question.toLowerCase().includes(rm.toLowerCase())
        )
      );

      // Calculate opportunity score
      const score = this.calculateOpportunityScore(
        market,
        relatedNews,
        relatedSignals,
        marketNewsLinks
      );

      // Determine direction based on signals
      const direction = this.determineDirection(relatedNews, relatedSignals);

      // Generate time context
      const timeContext = market.end_date_iso
        ? this.getTimeContext(new Date(market.end_date_iso), etTime)
        : 'No expiry date';

      // Detect category
      const category = this.detectCategory(market.question);

      // Generate reasoning
      const reasoning = this.generateReasoning(
        market,
        relatedNews,
        relatedSignals,
        direction,
        score
      );

      opportunities.push({
        id: `opp-${marketId}-${Date.now()}`,
        market,
        signals: relatedSignals,
        newsItems: relatedNews,
        score,
        direction,
        reasoning,
        confidence: Math.min(90, score + relatedNews.length * 5),
        timestamp: new Date(),
        category,
        timeContext,
      });
    }

    // Sort by score and return top opportunities
    return opportunities
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  private calculateOpportunityScore(
    market: PolymarketMarket,
    news: NewsItem[],
    signals: MarketSignal[],
    links: NewsMarketLink[]
  ): number {
    let score = 0;

    // News relevance (max 40 points)
    const avgRelevance = links.reduce((sum, l) => sum + l.relevanceScore, 0) / links.length;
    score += Math.min(40, avgRelevance * 0.4);

    // News count bonus (max 20 points)
    score += Math.min(20, news.length * 5);

    // Signal alignment (max 20 points)
    const bullishSignals = signals.filter(s => s.direction === 'bullish').length;
    const bearishSignals = signals.filter(s => s.direction === 'bearish').length;
    const signalAlignment = Math.abs(bullishSignals - bearishSignals) / Math.max(1, signals.length);
    score += Math.min(20, signalAlignment * 20);

    // Market metrics (max 20 points)
    if (market.volume_num > 50000) score += 10;
    if (market.liquidity > 5000) score += 5;
    if (market.spread < 0.05) score += 5;

    return Math.min(100, Math.round(score));
  }

  private determineDirection(news: NewsItem[], signals: MarketSignal[]): 'yes' | 'no' | 'neutral' {
    let bullish = 0;
    let bearish = 0;

    // From news sentiment
    for (const n of news) {
      if (n.sentiment === 'positive') bullish++;
      else if (n.sentiment === 'negative') bearish++;
    }

    // From signals
    for (const s of signals) {
      if (s.direction === 'bullish') bullish++;
      else if (s.direction === 'bearish') bearish++;
    }

    if (bullish > bearish * 1.5) return 'yes';
    if (bearish > bullish * 1.5) return 'no';
    return 'neutral';
  }

  private getTimeContext(endDate: Date, etTime: ReturnType<typeof getCurrentETTime>): string {
    const now = etTime.date;
    const diffMs = endDate.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 0) return 'Expired';
    if (diffHours < 1) return 'Expiring within 1 hour';
    if (diffHours < 24) return `${Math.round(diffHours)} hours remaining`;
    if (diffHours < 168) return `${Math.round(diffHours / 24)} days remaining`;
    return `${Math.round(diffHours / 168)} weeks remaining`;
  }

  private detectCategory(question: string): string {
    const q = question.toLowerCase();
    if (q.includes('bitcoin') || q.includes('ethereum') || q.includes('crypto')) return 'crypto';
    if (q.includes('election') || q.includes('president') || q.includes('congress')) return 'politics';
    if (q.includes('nfl') || q.includes('nba') || q.includes('championship')) return 'sports';
    if (q.includes('fed') || q.includes('inflation') || q.includes('rate')) return 'finance';
    if (q.includes('ai') || q.includes('apple') || q.includes('google')) return 'tech';
    return 'general';
  }

  private generateReasoning(
    market: PolymarketMarket,
    news: NewsItem[],
    signals: MarketSignal[],
    direction: 'yes' | 'no' | 'neutral',
    score: number
  ): string {
    const newsCount = news.length;
    const signalCount = signals.length;

    const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
    const currentPrice = yesToken?.price || 0.5;
    const impliedProb = Math.round(currentPrice * 100);

    let reasoning = `Market: "${market.question.slice(0, 60)}..."\n`;
    reasoning += `Current YES price: ${impliedProb}%\n`;
    reasoning += `Score: ${score}/100 | ${newsCount} related news | ${signalCount} signals\n`;

    if (direction !== 'neutral') {
      reasoning += `Direction: ${direction.toUpperCase()} - `;
      if (direction === 'yes' && currentPrice < 0.6) {
        reasoning += 'Bullish signals but market undervalued';
      } else if (direction === 'no' && currentPrice > 0.4) {
        reasoning += 'Bearish signals but market overvalued';
      } else {
        reasoning += 'Signals align with market pricing';
      }
    } else {
      reasoning += 'Direction: NEUTRAL - Mixed signals, no clear edge';
    }

    return reasoning;
  }

  // ============= Public API =============

  getOpportunities(): MarketOpportunity[] {
    return Array.from(this.opportunities.values())
      .sort((a, b) => b.score - a.score);
  }

  getOpportunitiesByCategory(category: string): MarketOpportunity[] {
    return this.getOpportunities().filter(o => o.category === category);
  }

  getTopOpportunities(limit = 5): MarketOpportunity[] {
    return this.getOpportunities().slice(0, limit);
  }

  getRecentLinks(limit = 50): NewsMarketLink[] {
    return this.newsMarketLinks.slice(0, limit);
  }

  /**
   * On-demand research for a specific topic
   */
  async researchTopic(topic: string): Promise<MarketOpportunity[]> {
    if (!this.runtime) return [];

    const polymarketService = this.runtime.getService<PolymarketService>('polymarket');
    const dataSourcesService = this.runtime.getService<DataSourcesService>('data-sources');

    if (!polymarketService || !dataSourcesService) return [];

    try {
      // Find markets related to topic
      const markets = await polymarketService.findMarketsForTopic(topic, 10);

      // Get fresh news
      const news = await dataSourcesService.getAllNews();

      // Filter news related to topic
      const topicKeywords = this.extractKeywords(topic);
      const relatedNews = news.filter(n => {
        const newsKeywords = this.extractKeywords(n.title + ' ' + n.summary);
        const common = topicKeywords.filter(k => newsKeywords.includes(k));
        return common.length >= 1;
      }).slice(0, 20);

      const etTime = getCurrentETTime();
      const opportunities: MarketOpportunity[] = [];

      for (const market of markets) {
        // Filter news for this market
        const marketKeywords = this.extractKeywords(market.question);
        const marketNews = relatedNews.filter(n => {
          const newsKeywords = this.extractKeywords(n.title);
          return newsKeywords.some(k => marketKeywords.includes(k));
        });

        if (marketNews.length === 0) continue;

        const score = 50 + marketNews.length * 10;
        const direction = this.determineDirection(marketNews, []);

        opportunities.push({
          id: `research-${market.condition_id}-${Date.now()}`,
          market,
          signals: [],
          newsItems: marketNews,
          score: Math.min(100, score),
          direction,
          reasoning: `Topic research: "${topic}"\nFound ${marketNews.length} related news items`,
          confidence: Math.min(80, 40 + marketNews.length * 10),
          timestamp: new Date(),
          category: this.detectCategory(market.question),
          timeContext: market.end_date_iso
            ? this.getTimeContext(new Date(market.end_date_iso), etTime)
            : 'No expiry',
        });
      }

      return opportunities.sort((a, b) => b.score - a.score);
    } catch (error) {
      logger.error({ error, topic }, '[MarketIntelligence] Research failed');
      return [];
    }
  }
}
