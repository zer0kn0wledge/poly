/**
 * Polymarket Trading Plugin for ElizaOS
 *
 * A production-ready plugin for trading on Polymarket prediction markets.
 *
 * Features:
 * - Buy and sell prediction market shares
 * - View markets and search for opportunities
 * - Portfolio tracking and P&L reporting
 * - Risk management with configurable limits
 * - Real-time market data via Polymarket CLOB API
 * - Autonomous trading with LLM-based market analysis
 * - Twitter posting for trade notifications (via IPostService)
 *
 * Configuration:
 * - POLYMARKET_PRIVATE_KEY: Ethereum private key for trading (required for trading)
 * - POLYMARKET_MAX_POSITION_SIZE: Maximum position size in USD (default: 100)
 * - POLYMARKET_MAX_PORTFOLIO_RISK: Maximum total portfolio exposure (default: 1000)
 * - POLYMARKET_MAX_DAILY_LOSS: Daily loss limit (default: 200)
 * - POLYMARKET_STOP_LOSS_PERCENT: Stop loss percentage (default: 20)
 * - POLYMARKET_TAKE_PROFIT_PERCENT: Take profit percentage (default: 50)
 *
 * Autonomous Trading Configuration:
 * - POLYMARKET_AUTO_TRADE: Enable autonomous trading ("true" or "1")
 * - POLYMARKET_ANALYSIS_INTERVAL: Market analysis interval in ms (default: 300000 / 5 min)
 * - POLYMARKET_MIN_CONFIDENCE: Minimum confidence % for trades (default: 75)
 */

import type { Plugin } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { z } from 'zod';

// Services
import { PolymarketService } from './services/polymarket';
import { DataSourcesService } from './services/data-sources';
import { TwitterMonitorService } from './services/twitter-monitor';
import { SignalGeneratorService } from './services/signal-generator';
import { LLMService } from './services/llm';
import { TwitterService } from './services/twitter';
import { StrategyLearningService } from './services/strategy-learning';
import { ScheduledPostsService } from './services/scheduled-posts';
import { MarketIntelligenceService } from './services/market-intelligence';

// Actions
import {
  buyOutcomeAction,
  sellOutcomeAction,
  viewMarketsAction,
  viewPositionAction,
  marketDetailsAction,
  researchMarketsAction,
} from './actions';

// Providers
import { portfolioProvider, marketsProvider, newsProvider, timezoneProvider } from './providers';

// Evaluators
import { tradingEvaluator } from './evaluators';

/**
 * Configuration schema for the Polymarket plugin
 */
const configSchema = z.object({
  POLYMARKET_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) {
        logger.warn('[Polymarket] No private key configured - running in read-only mode');
      }
      return val;
    }),
  POLYMARKET_MAX_POSITION_SIZE: z
    .string()
    .optional()
    .transform((val) => val ? parseFloat(val) : undefined),
  POLYMARKET_MAX_PORTFOLIO_RISK: z
    .string()
    .optional()
    .transform((val) => val ? parseFloat(val) : undefined),
  POLYMARKET_MAX_DAILY_LOSS: z
    .string()
    .optional()
    .transform((val) => val ? parseFloat(val) : undefined),
  POLYMARKET_STOP_LOSS_PERCENT: z
    .string()
    .optional()
    .transform((val) => val ? parseFloat(val) : undefined),
  POLYMARKET_TAKE_PROFIT_PERCENT: z
    .string()
    .optional()
    .transform((val) => val ? parseFloat(val) : undefined),
  // Autonomous trading settings
  POLYMARKET_AUTO_TRADE: z
    .string()
    .optional()
    .transform((val) => val === 'true' || val === '1'),
  POLYMARKET_ANALYSIS_INTERVAL: z
    .string()
    .optional()
    .transform((val) => val ? parseInt(val) : undefined),
  POLYMARKET_MIN_CONFIDENCE: z
    .string()
    .optional()
    .transform((val) => val ? parseInt(val) : undefined),
});

export const polymarketPlugin: Plugin = {
  name: 'plugin-polymarket',
  description: 'Polymarket prediction market trading plugin for ElizaOS',

  config: {
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
    POLYMARKET_MAX_POSITION_SIZE: process.env.POLYMARKET_MAX_POSITION_SIZE,
    POLYMARKET_MAX_PORTFOLIO_RISK: process.env.POLYMARKET_MAX_PORTFOLIO_RISK,
    POLYMARKET_MAX_DAILY_LOSS: process.env.POLYMARKET_MAX_DAILY_LOSS,
    POLYMARKET_STOP_LOSS_PERCENT: process.env.POLYMARKET_STOP_LOSS_PERCENT,
    POLYMARKET_TAKE_PROFIT_PERCENT: process.env.POLYMARKET_TAKE_PROFIT_PERCENT,
    POLYMARKET_AUTO_TRADE: process.env.POLYMARKET_AUTO_TRADE,
    POLYMARKET_ANALYSIS_INTERVAL: process.env.POLYMARKET_ANALYSIS_INTERVAL,
    POLYMARKET_MIN_CONFIDENCE: process.env.POLYMARKET_MIN_CONFIDENCE,
  },

  async init(config: Record<string, string>) {
    logger.info('[Polymarket] Initializing plugin');

    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set environment variables
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value !== undefined) {
          process.env[key] = String(value);
        }
      }

      logger.info('[Polymarket] Plugin initialized successfully');
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.issues?.map((e) => e.message)?.join(', ') || 'Unknown validation error';
        throw new Error(`Invalid Polymarket plugin configuration: ${errorMessages}`);
      }
      throw error;
    }
  },

  // Services
  services: [
    PolymarketService,
    DataSourcesService,
    TwitterMonitorService,
    SignalGeneratorService,
    LLMService,
    TwitterService,
    StrategyLearningService,
    ScheduledPostsService,
    MarketIntelligenceService,
  ],

  // Actions for trading and market interaction
  actions: [
    buyOutcomeAction,
    sellOutcomeAction,
    viewMarketsAction,
    viewPositionAction,
    marketDetailsAction,
    researchMarketsAction,
  ],

  // Providers for context injection
  providers: [
    portfolioProvider,
    marketsProvider,
    newsProvider,
    timezoneProvider,
  ],

  // Evaluators for autonomous behavior
  evaluators: [
    tradingEvaluator,
  ],

  // Event handlers
  events: {
    WORLD_CONNECTED: [
      async (params) => {
        logger.debug('[Polymarket] World connected event');
      },
    ],
  },

  // HTTP routes for external integrations
  routes: [
    {
      name: 'polymarket-status',
      path: '/polymarket/status',
      type: 'GET',
      handler: async (req, res) => {
        res.json({
          status: 'ok',
          plugin: 'polymarket',
          version: '1.0.0',
          features: [
            'market-search',
            'buy-shares',
            'sell-shares',
            'portfolio-tracking',
            'risk-management',
          ],
        });
      },
    },
    {
      name: 'polymarket-markets',
      path: '/polymarket/markets',
      type: 'GET',
      public: true,
      handler: async (req, res) => {
        try {
          // This would need runtime context to work properly
          // For now, return a placeholder
          res.json({
            message: 'Use the agent interface to search markets',
            example: 'Ask: "Show me crypto prediction markets"',
          });
        } catch (error) {
          res.status(500).json({ error: 'Failed to fetch markets' });
        }
      },
    },
  ],
};

export default polymarketPlugin;
