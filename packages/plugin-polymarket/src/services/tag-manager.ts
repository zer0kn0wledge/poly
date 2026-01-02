/**
 * Tag Manager Service
 *
 * Dynamically fetches and caches Polymarket category tags for proper market filtering.
 * The Gamma API has ~9,000 tags - we cache them and map categories to tag IDs.
 */

import { Service, IAgentRuntime, logger } from '@elizaos/core';

interface Tag {
  id: string;
  label: string;
  slug: string;
}

interface TagCache {
  tags: Tag[];
  byId: Map<string, Tag>;
  bySlug: Map<string, Tag>;
  byLabel: Map<string, Tag>;
  lastUpdated: Date;
}

interface SportsConfig {
  sport: string;
  tags: string;
  series?: string;
}

export class TagManagerService extends Service {
  static serviceType = 'tag-manager';

  private runtime: IAgentRuntime | null = null;
  private cache: TagCache | null = null;
  private sportsTagIds: string[] = [];
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly GAMMA_BASE = 'https://gamma-api.polymarket.com';

  // Known category-to-slug mappings (fallback if dynamic fetch fails)
  private readonly CATEGORY_SLUGS: Record<string, string[]> = {
    sports: [
      'sports', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'epl', 'mma', 'ufc',
      'boxing', 'tennis', 'golf', 'super-bowl', 'world-series', 'nba-finals',
      'stanley-cup', 'college-football', 'college-basketball', 'f1', 'olympics'
    ],
    crypto: [
      'crypto', 'bitcoin', 'ethereum', 'altcoins', 'defi', 'nfts',
      'crypto-prices', 'airdrops', 'solana', 'base', 'sui', 'ton'
    ],
    politics: [
      'politics', 'us-politics', 'elections', 'trump', 'congress',
      'global-elections', 'biden', 'republican', 'democrat', 'primaries'
    ],
    economics: [
      'economics', 'fed', 'fed-rates', 'inflation', 'economy',
      'recession', 'gdp', 'jobs', 'trade', 'tariffs'
    ],
    entertainment: [
      'movies', 'box-office', 'music', 'culture', 'hollywood',
      'games', 'oscars', 'emmys', 'grammys', 'tv-shows'
    ],
    tech: [
      'technology', 'ai', 'tech', 'apple', 'google', 'microsoft',
      'openai', 'spacex', 'tesla'
    ],
    science: [
      'science', 'space', 'climate', 'health', 'medicine'
    ],
    world: [
      'world', 'international', 'geopolitics', 'ukraine', 'russia',
      'china', 'middle-east', 'europe'
    ]
  };

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info('[TagManager] Initializing...');

    // Fetch tags in background - don't block startup
    this.refreshTagCache().catch(err => {
      logger.warn('[TagManager] Initial tag fetch failed, will use fallback:', err);
    });

    // Also fetch sports-specific tags
    this.fetchSportsTagIds().catch(err => {
      logger.warn('[TagManager] Sports tag fetch failed:', err);
    });
  }

  async stop(): Promise<void> {
    this.cache = null;
    this.sportsTagIds = [];
  }

  /**
   * Refresh the tag cache from Polymarket API
   */
  async refreshTagCache(): Promise<void> {
    try {
      logger.info('[TagManager] Fetching tags from Polymarket...');

      const allTags: Tag[] = [];
      let offset = 0;
      const limit = 100;
      let fetchCount = 0;

      // Paginate through all tags (up to 10,000)
      while (fetchCount < 100) { // Max 100 requests = 10,000 tags
        const url = `${this.GAMMA_BASE}/tags?limit=${limit}&offset=${offset}`;

        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
          logger.warn(`[TagManager] Tags API returned ${response.status}`);
          break;
        }

        const tags = await response.json();

        if (!tags || !Array.isArray(tags) || tags.length === 0) break;

        allTags.push(...tags);
        offset += limit;
        fetchCount++;

        // If we got less than limit, we've reached the end
        if (tags.length < limit) break;
      }

      // Build cache with multiple access patterns
      this.cache = {
        tags: allTags,
        byId: new Map(allTags.map(t => [t.id, t])),
        bySlug: new Map(allTags.map(t => [t.slug?.toLowerCase(), t])),
        byLabel: new Map(allTags.map(t => [t.label?.toLowerCase(), t])),
        lastUpdated: new Date()
      };

      logger.info(`[TagManager] Cached ${allTags.length} tags`);

    } catch (error) {
      logger.error('[TagManager] Failed to fetch tags:', error);
      throw error;
    }
  }

  /**
   * Fetch sports-specific tag IDs from /sports endpoint
   */
  async fetchSportsTagIds(): Promise<void> {
    try {
      const response = await fetch(`${this.GAMMA_BASE}/sports`, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        logger.warn(`[TagManager] Sports API returned ${response.status}`);
        return;
      }

      const sports: SportsConfig[] = await response.json();
      const tagIds: string[] = [];

      for (const sport of sports) {
        if (sport.tags) {
          // Tags might be comma-separated string
          const sportTags = typeof sport.tags === 'string'
            ? sport.tags.split(',').map(t => t.trim())
            : [sport.tags];
          tagIds.push(...sportTags);
        }
      }

      this.sportsTagIds = [...new Set(tagIds)]; // Dedupe
      logger.info(`[TagManager] Fetched ${this.sportsTagIds.length} sports tag IDs`);

    } catch (error) {
      logger.warn('[TagManager] Failed to fetch sports tags:', error);
    }
  }

  /**
   * Get tag IDs for a category
   */
  getTagIdsForCategory(category: string): string[] {
    const normalizedCategory = category.toLowerCase().trim();
    const tagIds: string[] = [];

    // Special case: sports has dedicated endpoint
    if (normalizedCategory === 'sports' && this.sportsTagIds.length > 0) {
      return this.sportsTagIds;
    }

    // Get slugs for this category
    const slugs = this.CATEGORY_SLUGS[normalizedCategory] || [normalizedCategory];

    if (!this.cache) {
      logger.warn('[TagManager] Cache not initialized, using hardcoded fallback');
      return this.getHardcodedTagIds(normalizedCategory);
    }

    // Find tag IDs by slug
    for (const slug of slugs) {
      const tag = this.cache.bySlug.get(slug.toLowerCase());
      if (tag) {
        tagIds.push(tag.id);
      }
    }

    // Also search by label if we didn't find enough
    if (tagIds.length < 3) {
      for (const [label, tag] of this.cache.byLabel) {
        if (label && label.includes(normalizedCategory) && !tagIds.includes(tag.id)) {
          tagIds.push(tag.id);
        }
      }
    }

    logger.debug(`[TagManager] Category '${category}' -> ${tagIds.length} tag IDs`);

    return tagIds;
  }

  /**
   * Get sports-specific tag IDs
   */
  getSportsTagIds(): string[] {
    return this.sportsTagIds;
  }

  /**
   * Search tags by keyword
   */
  searchTags(keyword: string): Tag[] {
    if (!this.cache) return [];

    const lowerKeyword = keyword.toLowerCase();

    return this.cache.tags.filter(tag =>
      tag.label?.toLowerCase().includes(lowerKeyword) ||
      tag.slug?.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get tag by ID
   */
  getTagById(id: string): Tag | undefined {
    return this.cache?.byId.get(id);
  }

  /**
   * Check if cache is stale
   */
  isCacheStale(): boolean {
    if (!this.cache) return true;
    const age = Date.now() - this.cache.lastUpdated.getTime();
    return age > this.CACHE_TTL_MS;
  }

  /**
   * Hardcoded fallback tag IDs if API is unavailable
   * These may become outdated but provide basic functionality
   */
  private getHardcodedTagIds(category: string): string[] {
    const hardcoded: Record<string, string[]> = {
      // These are example IDs - actual IDs need to be fetched from API
      sports: ['100381', '100382', '100383'], // NFL, NBA, MLB placeholders
      crypto: ['21', '22', '23'], // Crypto category placeholders
      politics: ['31', '32', '33'], // Politics placeholders
      economics: ['41', '42'], // Economics placeholders
    };

    return hardcoded[category] || [];
  }
}
