/**
 * Autonomous Trading Evaluator
 *
 * Periodically analyzes markets and decides whether to place trades.
 * Uses LLM reasoning to evaluate opportunities and manage positions.
 * Posts trade notifications to Twitter via IPostService.
 */

import type {
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
  Service,
} from '@elizaos/core';
import { ModelType, logger, ServiceType } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';
import type { PolymarketMarket } from '../types';

// Type for IPostService (avoid direct import to keep plugin standalone)
interface PostContent {
  text?: string;
  tags?: string[];
}

interface IPostServiceLike extends Service {
  createPost(content: PostContent, options?: Record<string, unknown>): Promise<string>;
}

// Cache key for last analysis time
const LAST_ANALYSIS_KEY = 'polymarket-last-analysis';
const DEFAULT_ANALYSIS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MIN_CONFIDENCE = 75;

/**
 * Get configuration values from environment
 */
function getConfig() {
  return {
    autoTradeEnabled: process.env.POLYMARKET_AUTO_TRADE === 'true' || process.env.POLYMARKET_AUTO_TRADE === '1',
    analysisIntervalMs: parseInt(process.env.POLYMARKET_ANALYSIS_INTERVAL || '') || DEFAULT_ANALYSIS_INTERVAL_MS,
    minConfidence: parseInt(process.env.POLYMARKET_MIN_CONFIDENCE || '') || DEFAULT_MIN_CONFIDENCE,
  };
}

interface MarketOpportunity {
  market: PolymarketMarket;
  signal: 'BUY_YES' | 'BUY_NO' | 'HOLD';
  confidence: number;
  reasoning: string;
  suggestedSize: number;
}

interface TradeDecision {
  shouldTrade: boolean;
  opportunities: MarketOpportunity[];
  marketAnalysis: string;
}

const analysisPrompt = `You are an expert prediction market trader analyzing Polymarket opportunities.

Current Portfolio:
{{portfolio}}

Risk Settings:
- Max Position Size: ${{maxPositionSize}}
- Max Portfolio Risk: ${{maxPortfolioRisk}}
- Daily Loss Limit: ${{maxDailyLoss}}

Active Markets to Analyze:
{{markets}}

Your task:
1. Analyze each market for trading opportunities
2. Look for mispriced markets where your estimate differs significantly from current odds
3. Consider news, trends, and any edge you might have
4. Be conservative - only recommend trades with high confidence

For each market, evaluate:
- Is the current price accurate based on available information?
- Is there a clear edge (>10% mispricing)?
- What's the risk/reward ratio?

Respond with JSON:
{
  "shouldTrade": boolean,
  "marketAnalysis": "Overall market conditions and reasoning",
  "opportunities": [
    {
      "marketQuestion": "The market question",
      "signal": "BUY_YES" | "BUY_NO" | "HOLD",
      "confidence": 0-100,
      "reasoning": "Why this trade makes sense",
      "currentPrice": 0.XX,
      "targetPrice": 0.XX,
      "suggestedSize": dollar amount
    }
  ]
}

Only include opportunities where confidence > 70 and signal is not HOLD.
Be selective - it's better to make no trade than a bad trade.`;

/**
 * Analyze markets and find trading opportunities
 */
async function analyzeMarkets(
  runtime: IAgentRuntime,
  service: PolymarketService
): Promise<TradeDecision> {
  try {
    // Fetch active markets
    const markets = await service.getMarkets({ active: true, limit: 20 });

    // Get portfolio status
    const portfolio = await service.getPortfolio();
    const riskSettings = service.getRiskSettings();

    // Format markets for analysis
    const marketsText = markets.slice(0, 10).map((m, i) => {
      const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
      const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
      return `${i + 1}. "${m.question}"
   - Yes: ${((yesToken?.price ?? 0.5) * 100).toFixed(1)}%
   - No: ${((noToken?.price ?? 0.5) * 100).toFixed(1)}%
   - Volume: $${m.volume_num.toLocaleString()}
   - End Date: ${m.end_date_iso}`;
    }).join('\n\n');

    // Format portfolio
    const portfolioText = `
Total Value: $${portfolio.totalValue.toFixed(2)}
Cash Available: $${portfolio.cashBalance.toFixed(2)}
Unrealized P&L: ${portfolio.unrealizedPnl >= 0 ? '+' : ''}$${portfolio.unrealizedPnl.toFixed(2)}
Open Positions: ${portfolio.positions.length}`;

    const prompt = analysisPrompt
      .replace('{{portfolio}}', portfolioText)
      .replace('{{maxPositionSize}}', riskSettings.maxPositionSize.toString())
      .replace('{{maxPortfolioRisk}}', riskSettings.maxPortfolioRisk.toString())
      .replace('{{maxDailyLoss}}', riskSettings.maxDailyLoss.toString())
      .replace('{{markets}}', marketsText);

    // Get LLM analysis
    const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
      prompt,
      schema: {
        type: 'object',
        properties: {
          shouldTrade: { type: 'boolean' },
          marketAnalysis: { type: 'string' },
          opportunities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                marketQuestion: { type: 'string' },
                signal: { type: 'string' },
                confidence: { type: 'number' },
                reasoning: { type: 'string' },
                currentPrice: { type: 'number' },
                targetPrice: { type: 'number' },
                suggestedSize: { type: 'number' },
              },
            },
          },
        },
        required: ['shouldTrade', 'marketAnalysis', 'opportunities'],
      },
    });

    if (!response || typeof response !== 'object') {
      return { shouldTrade: false, opportunities: [], marketAnalysis: 'Analysis failed' };
    }

    const analysis = response as any;

    // Map opportunities to markets
    const opportunities: MarketOpportunity[] = [];
    for (const opp of analysis.opportunities || []) {
      const market = markets.find(m =>
        m.question.toLowerCase().includes(opp.marketQuestion?.toLowerCase()?.slice(0, 30) || '')
      );

      if (market && opp.signal !== 'HOLD' && opp.confidence >= 70) {
        opportunities.push({
          market,
          signal: opp.signal,
          confidence: opp.confidence,
          reasoning: opp.reasoning,
          suggestedSize: Math.min(opp.suggestedSize || 25, riskSettings.maxPositionSize),
        });
      }
    }

    return {
      shouldTrade: analysis.shouldTrade && opportunities.length > 0,
      opportunities,
      marketAnalysis: analysis.marketAnalysis,
    };
  } catch (error) {
    logger.error({ error }, '[TradingEvaluator] Market analysis failed');
    return { shouldTrade: false, opportunities: [], marketAnalysis: 'Error during analysis' };
  }
}

/**
 * Post trade notification to Twitter if PostService is available
 */
async function postTradeToTwitter(
  runtime: IAgentRuntime,
  opportunity: MarketOpportunity,
  result: { success: boolean; message: string; orderId?: string }
): Promise<void> {
  try {
    // Try to get the post service (Twitter, etc.)
    const postService = runtime.getService(ServiceType.POST) as IPostServiceLike | undefined;

    if (!postService) {
      logger.debug('[TradingEvaluator] No post service available, skipping Twitter notification');
      return;
    }

    const tweetText = formatTradeForTwitter(opportunity, result);

    await postService.createPost(
      { text: tweetText, tags: ['Polymarket', 'PredictionMarkets', 'Trading'] },
      { visibility: 'public' }
    );

    logger.info('[TradingEvaluator] Trade notification posted to Twitter');
  } catch (error) {
    logger.warn({ error }, '[TradingEvaluator] Failed to post trade notification to Twitter');
  }
}

/**
 * Execute a trade and return the result for posting
 */
async function executeTrade(
  service: PolymarketService,
  opportunity: MarketOpportunity
): Promise<{ success: boolean; message: string; orderId?: string }> {
  try {
    const outcome = opportunity.signal === 'BUY_YES' ? 'Yes' : 'No';
    const token = opportunity.market.tokens.find(
      t => t.outcome.toLowerCase() === outcome.toLowerCase()
    );

    if (!token) {
      return { success: false, message: 'Token not found' };
    }

    const price = token.price;
    const shares = opportunity.suggestedSize / price;

    const result = await service.placeOrder({
      tokenId: token.token_id,
      side: 'BUY',
      price,
      size: shares,
      orderType: 'GTC',
    });

    return {
      success: true,
      orderId: result.orderId,
      message: `Bought ${shares.toFixed(2)} shares of ${outcome} @ $${price.toFixed(4)}`,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Trade failed',
    };
  }
}

/**
 * Trading Evaluator Handler
 */
async function handler(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State
): Promise<void> {
  const service = runtime.getService<PolymarketService>('polymarket');

  if (!service || service.isReadOnly()) {
    logger.debug('[TradingEvaluator] Service not available or read-only');
    return;
  }

  logger.info('[TradingEvaluator] Running autonomous market analysis...');

  // Analyze markets
  const decision = await analyzeMarkets(runtime, service);

  logger.info({
    shouldTrade: decision.shouldTrade,
    opportunityCount: decision.opportunities.length,
    analysis: decision.marketAnalysis,
  }, '[TradingEvaluator] Analysis complete');

  if (!decision.shouldTrade || decision.opportunities.length === 0) {
    logger.info('[TradingEvaluator] No trading opportunities found');
    await runtime.setCache(LAST_ANALYSIS_KEY, Date.now().toString());
    return;
  }

  const config = getConfig();

  // Execute trades for high-confidence opportunities
  for (const opportunity of decision.opportunities) {
    if (opportunity.confidence < config.minConfidence) continue;

    logger.info({
      market: opportunity.market.question,
      signal: opportunity.signal,
      confidence: opportunity.confidence,
      size: opportunity.suggestedSize,
    }, '[TradingEvaluator] Executing trade');

    const result = await executeTrade(service, opportunity);

    if (result.success) {
      logger.info({ orderId: result.orderId }, '[TradingEvaluator] Trade executed');

      // Post trade notification to Twitter
      await postTradeToTwitter(runtime, opportunity, result);

      // Create trade notification memory for record keeping
      const tradeNotification: Memory = {
        id: crypto.randomUUID() as any,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: formatTradeForTwitter(opportunity, result),
          action: 'POLYMARKET_TRADE',
          metadata: {
            market: opportunity.market.question,
            signal: opportunity.signal,
            confidence: opportunity.confidence,
            reasoning: opportunity.reasoning,
            orderId: result.orderId,
          },
        },
        createdAt: Date.now(),
      };

      // Store the trade notification for record keeping
      await runtime.createMemory(tradeNotification, 'polymarket_trades', true);

      // Emit event for trade notification (other plugins can listen)
      runtime.emit('POLYMARKET_TRADE_EXECUTED', {
        runtime,
        trade: {
          market: opportunity.market.question,
          signal: opportunity.signal,
          confidence: opportunity.confidence,
          reasoning: opportunity.reasoning,
          orderId: result.orderId,
          message: result.message,
        },
      });
    } else {
      logger.warn({ error: result.message }, '[TradingEvaluator] Trade failed');
    }
  }

  await runtime.setCache(LAST_ANALYSIS_KEY, Date.now().toString());
}

/**
 * Format trade for Twitter post
 */
function formatTradeForTwitter(
  opportunity: MarketOpportunity,
  result: { success: boolean; message: string; orderId?: string }
): string {
  const outcome = opportunity.signal === 'BUY_YES' ? 'YES' : 'NO';
  const emoji = opportunity.signal === 'BUY_YES' ? '🟢' : '🔴';

  return `${emoji} New Polymarket Trade

📊 ${opportunity.market.question.slice(0, 100)}${opportunity.market.question.length > 100 ? '...' : ''}

Position: ${outcome} @ ${((opportunity.market.tokens.find(t => t.outcome.toLowerCase() === outcome.toLowerCase())?.price ?? 0.5) * 100).toFixed(0)}%
Size: $${opportunity.suggestedSize.toFixed(0)}
Confidence: ${opportunity.confidence}%

💭 Reasoning: ${opportunity.reasoning.slice(0, 150)}${opportunity.reasoning.length > 150 ? '...' : ''}

#Polymarket #PredictionMarkets #Trading`;
}

export const tradingEvaluator: Evaluator = {
  name: 'POLYMARKET_TRADING',
  similes: ['AUTONOMOUS_TRADING', 'MARKET_ANALYSIS', 'TRADE_EVALUATION'],
  description: 'Autonomously analyzes Polymarket prediction markets and executes trades based on LLM reasoning',

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const config = getConfig();

    // Check if autonomous trading is enabled
    if (!config.autoTradeEnabled) {
      return false;
    }

    // Check if service is available
    const service = runtime.getService<PolymarketService>('polymarket');
    if (!service || service.isReadOnly()) {
      return false;
    }

    // Check if enough time has passed since last analysis
    const lastAnalysis = await runtime.getCache<string>(LAST_ANALYSIS_KEY);
    if (lastAnalysis) {
      const elapsed = Date.now() - parseInt(lastAnalysis);
      if (elapsed < config.analysisIntervalMs) {
        return false;
      }
    }

    return true;
  },

  handler,

  examples: [
    {
      prompt: 'Autonomous trading evaluation',
      messages: [
        {
          name: 'System',
          content: { text: 'Running periodic market analysis' },
        },
      ],
      outcome: 'Analyzed 10 markets, found 1 opportunity: BUY YES on "Will Bitcoin reach $100k?" at 65% (current 55%), confidence 82%',
    },
  ],
};
