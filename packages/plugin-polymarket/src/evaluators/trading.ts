/**
 * Autonomous Trading Evaluator
 *
 * Periodically analyzes markets and decides whether to place trades.
 * Uses SignalGeneratorService to aggregate all data sources:
 * - CryptoPanic (crypto news)
 * - CoinGecko + DeFiLlama (crypto prices/DeFi)
 * - SportMonks (sports data)
 * - Twitter monitoring (social signals)
 * - News scraping (politics, economy, geopolitics)
 *
 * Posts trade notifications to Twitter via IPostService.
 */

import type {
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
  Service,
} from '@elizaos/core';
import { logger, ServiceType } from '@elizaos/core';
import { PolymarketService } from '../services/polymarket';
import { SignalGeneratorService, type TradingSignal, type SignalFactors } from '../services/signal-generator';
import { LLMService } from '../services/llm';
import { TwitterService } from '../services/twitter';
import type { PolymarketMarket } from '../types';
import { getCurrentETTime, isMarketExpired, detectPastYearMarket, getRelativeTimeContext } from '../providers/timezone';
import { newsProvider } from '../providers/news';
import { StrategyLearningService, type DataSignalRecord } from '../services/strategy-learning';
import { DataSourcesService } from '../services/data-sources';

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
const DEFAULT_MIN_COMPOSITE_SCORE = 50;
const DEFAULT_MIN_CONSENSUS = 55;

/**
 * Get configuration values from environment
 */
function getConfig() {
  return {
    autoTradeEnabled: process.env.POLYMARKET_AUTO_TRADE === 'true' || process.env.POLYMARKET_AUTO_TRADE === '1',
    analysisIntervalMs: parseInt(process.env.POLYMARKET_ANALYSIS_INTERVAL || '') || DEFAULT_ANALYSIS_INTERVAL_MS,
    minConfidence: parseInt(process.env.POLYMARKET_MIN_CONFIDENCE || '') || DEFAULT_MIN_CONFIDENCE,
    minCompositeScore: parseInt(process.env.POLYMARKET_MIN_COMPOSITE || '') || DEFAULT_MIN_COMPOSITE_SCORE,
    minConsensus: parseInt(process.env.POLYMARKET_MIN_CONSENSUS || '') || DEFAULT_MIN_CONSENSUS,
    maxConcurrentTrades: parseInt(process.env.POLYMARKET_MAX_CONCURRENT || '') || 3,
    kellyFraction: parseFloat(process.env.POLYMARKET_KELLY_FRACTION || '') || 0.25, // Fractional Kelly
  };
}

/**
 * Decision pipeline stages
 */
enum PipelineStage {
  PRE_SCREEN = 'PRE_SCREEN',
  FACTOR_VALIDATION = 'FACTOR_VALIDATION',
  RISK_ASSESSMENT = 'RISK_ASSESSMENT',
  SIZE_CALCULATION = 'SIZE_CALCULATION',
  FINAL_APPROVAL = 'FINAL_APPROVAL',
}

/**
 * Pipeline decision result
 */
interface PipelineDecision {
  signal: TradingSignal;
  stage: PipelineStage;
  approved: boolean;
  reason: string;
  adjustedSize?: number;
  riskScore?: number;
  kellySize?: number;
}

interface MarketOpportunity {
  market: PolymarketMarket;
  signal: 'BUY_YES' | 'BUY_NO' | 'HOLD';
  confidence: number;
  reasoning: string;
  suggestedSize: number;
  factors?: SignalFactors;
}

// ============= Decision Pipeline Functions =============

/**
 * Stage 1: Pre-screen signals for basic quality
 */
function preScreenSignal(signal: TradingSignal, config: ReturnType<typeof getConfig>): PipelineDecision {
  // Check minimum confidence
  if (signal.confidence < config.minConfidence) {
    return {
      signal,
      stage: PipelineStage.PRE_SCREEN,
      approved: false,
      reason: `Confidence ${signal.confidence}% below minimum ${config.minConfidence}%`,
    };
  }

  // Check minimum edge
  if (Math.abs(signal.edge) < 10) {
    return {
      signal,
      stage: PipelineStage.PRE_SCREEN,
      approved: false,
      reason: `Edge ${signal.edge}% below minimum 10%`,
    };
  }

  // Check supporting data exists
  const totalData = (signal.supportingData.news?.length || 0) +
                   (signal.supportingData.tweets?.length || 0) +
                   (signal.supportingData.priceSignals?.length || 0) +
                   (signal.supportingData.webSignals?.length || 0);

  if (totalData < 2) {
    return {
      signal,
      stage: PipelineStage.PRE_SCREEN,
      approved: false,
      reason: `Insufficient supporting data (${totalData} sources)`,
    };
  }

  return {
    signal,
    stage: PipelineStage.PRE_SCREEN,
    approved: true,
    reason: 'Pre-screen passed',
  };
}

/**
 * Stage 2: Validate multi-factor scores
 */
function validateFactors(signal: TradingSignal, config: ReturnType<typeof getConfig>): PipelineDecision {
  const factors = signal.factors;

  if (!factors) {
    // No factors available - use legacy validation
    return {
      signal,
      stage: PipelineStage.FACTOR_VALIDATION,
      approved: true,
      reason: 'Legacy signal without factors - proceeding with caution',
    };
  }

  // Check composite score
  if (factors.compositeScore < config.minCompositeScore) {
    return {
      signal,
      stage: PipelineStage.FACTOR_VALIDATION,
      approved: false,
      reason: `Composite score ${factors.compositeScore} below minimum ${config.minCompositeScore}`,
    };
  }

  // Check consensus
  if (factors.consensusScore < config.minConsensus) {
    return {
      signal,
      stage: PipelineStage.FACTOR_VALIDATION,
      approved: false,
      reason: `Consensus score ${factors.consensusScore} below minimum ${config.minConsensus} - mixed signals`,
    };
  }

  // Check time decay - stale signals are risky
  if (factors.timeDecay < 0.5) {
    return {
      signal,
      stage: PipelineStage.FACTOR_VALIDATION,
      approved: false,
      reason: `Signal freshness ${(factors.timeDecay * 100).toFixed(0)}% too low - data is stale`,
    };
  }

  return {
    signal,
    stage: PipelineStage.FACTOR_VALIDATION,
    approved: true,
    reason: `Factors validated: composite=${factors.compositeScore}, consensus=${factors.consensusScore}`,
  };
}

/**
 * Stage 3: Assess risk based on market conditions
 */
function assessRisk(signal: TradingSignal, portfolio: { totalValue: number; positions: any[] }): PipelineDecision {
  const factors = signal.factors;
  let riskScore = 50; // Base risk

  // Adjust risk based on volume/liquidity
  if (factors) {
    if (factors.volumeScore < 50) {
      riskScore += 20; // Low liquidity = higher risk
    } else if (factors.volumeScore > 80) {
      riskScore -= 10; // High liquidity = lower risk
    }

    // Consensus affects risk
    if (factors.consensusScore > 80) {
      riskScore -= 15; // High consensus = lower risk
    } else if (factors.consensusScore < 60) {
      riskScore += 15; // Low consensus = higher risk
    }
  }

  // Market spread affects risk
  const spread = signal.market.spread || 0;
  if (spread > 0.05) {
    riskScore += 15; // Wide spread = harder to exit
  }

  // Portfolio concentration risk
  const existingPosition = portfolio.positions.find(p =>
    p.market.condition_id === signal.market.condition_id
  );
  if (existingPosition) {
    riskScore += 25; // Already have position = concentration risk
  }

  // High risk threshold
  if (riskScore > 75) {
    return {
      signal,
      stage: PipelineStage.RISK_ASSESSMENT,
      approved: false,
      reason: `Risk score ${riskScore} too high (liquidity, spread, or concentration issues)`,
      riskScore,
    };
  }

  return {
    signal,
    stage: PipelineStage.RISK_ASSESSMENT,
    approved: true,
    reason: `Risk assessment passed with score ${riskScore}`,
    riskScore,
  };
}

/**
 * Stage 4: Calculate optimal position size using Kelly Criterion
 */
function calculateKellySize(
  signal: TradingSignal,
  riskSettings: { maxPositionSize: number; maxPortfolioRisk: number },
  config: ReturnType<typeof getConfig>
): PipelineDecision {
  // Kelly Criterion: f* = (bp - q) / b
  // Where: b = odds, p = probability of winning, q = probability of losing

  const currentPrice = signal.direction === 'BUY_YES'
    ? (signal.market.tokens.find(t => t.outcome.toLowerCase() === 'yes')?.price || 0.5)
    : (signal.market.tokens.find(t => t.outcome.toLowerCase() === 'no')?.price || 0.5);

  // Estimated true probability based on our edge
  const estimatedProb = signal.direction === 'BUY_YES'
    ? currentPrice + (signal.edge / 100)
    : (1 - currentPrice) + (signal.edge / 100);

  // Clamp probability to valid range
  const p = Math.min(0.95, Math.max(0.05, estimatedProb));
  const q = 1 - p;

  // Odds (payout ratio) - if we win, we get 1/price
  const b = (1 / currentPrice) - 1;

  // Kelly fraction
  const kellyFraction = (b * p - q) / b;

  // Apply fractional Kelly for safety
  const adjustedKelly = kellyFraction * config.kellyFraction;

  // Calculate suggested size
  const kellySize = Math.max(0, adjustedKelly * riskSettings.maxPortfolioRisk);

  // Cap at max position size
  const finalSize = Math.min(kellySize, riskSettings.maxPositionSize);

  // Minimum viable trade size
  if (finalSize < 5) { // Less than $5
    return {
      signal,
      stage: PipelineStage.SIZE_CALCULATION,
      approved: false,
      reason: `Kelly-optimal size $${finalSize.toFixed(2)} too small for viable trade`,
      kellySize: finalSize,
    };
  }

  return {
    signal,
    stage: PipelineStage.SIZE_CALCULATION,
    approved: true,
    reason: `Kelly size: $${finalSize.toFixed(2)} (${(adjustedKelly * 100).toFixed(1)}% of bankroll)`,
    adjustedSize: finalSize,
    kellySize: finalSize,
  };
}

/**
 * Run full decision pipeline
 */
function runDecisionPipeline(
  signal: TradingSignal,
  portfolio: { totalValue: number; positions: any[] },
  riskSettings: { maxPositionSize: number; maxPortfolioRisk: number },
  config: ReturnType<typeof getConfig>
): PipelineDecision {
  // Stage 1: Pre-screen
  const preScreen = preScreenSignal(signal, config);
  if (!preScreen.approved) {
    return preScreen;
  }

  // Stage 2: Factor validation
  const factorValidation = validateFactors(signal, config);
  if (!factorValidation.approved) {
    return factorValidation;
  }

  // Stage 3: Risk assessment
  const riskAssessment = assessRisk(signal, portfolio);
  if (!riskAssessment.approved) {
    return riskAssessment;
  }

  // Stage 4: Size calculation
  const sizeCalc = calculateKellySize(signal, riskSettings, config);
  if (!sizeCalc.approved) {
    return sizeCalc;
  }

  // Stage 5: Final approval
  return {
    signal,
    stage: PipelineStage.FINAL_APPROVAL,
    approved: true,
    reason: `All stages passed. Risk: ${riskAssessment.riskScore}, Size: $${sizeCalc.adjustedSize?.toFixed(2)}`,
    adjustedSize: sizeCalc.adjustedSize,
    riskScore: riskAssessment.riskScore,
    kellySize: sizeCalc.kellySize,
  };
}

interface TradeDecision {
  shouldTrade: boolean;
  opportunities: MarketOpportunity[];
  marketAnalysis: string;
}

const analysisPrompt = `You are an expert prediction market trader analyzing Polymarket opportunities.
You use fundamental analysis, news, and market data to find mispriced opportunities.

CURRENT DATE/TIME CONTEXT:
- Today: {{currentDate}}
- Time: {{currentTime}} ET (US Eastern Time)
- Current Year: {{currentYear}}
- CRITICAL: Markets referencing years before {{currentYear}} have already resolved. Do NOT trade expired markets.

Current Portfolio:
{{portfolio}}

Risk Settings:
- Max Position Size: {{maxPositionSize}} USD
- Max Portfolio Risk: {{maxPortfolioRisk}} USD
- Daily Loss Limit: {{maxDailyLoss}} USD

{{newsContext}}

Active Markets to Analyze:
{{markets}}

Your task:
1. FIRST: Verify each market is still relevant given today's date ({{currentDate}})
2. Skip any markets that reference past years or have already ended
3. Analyze remaining markets for trading opportunities
4. Use the news context to inform your probability estimates
5. Look for mispriced markets where your estimate differs significantly (>10%) from current odds
6. Consider recent developments that the market may not have priced in yet
7. Be conservative - only recommend trades with high confidence

For each market, evaluate:
- Is this market still active and relevant as of {{currentDate}}?
- What does recent news tell us about the likely outcome?
- Is the current price accurate based on all available information?
- Is there a clear edge (>10% mispricing)?
- What's the risk/reward ratio?

Respond with JSON:
{
  "shouldTrade": boolean,
  "marketAnalysis": "Overall market conditions and key news insights (considering current date: {{currentDate}})",
  "opportunities": [
    {
      "marketQuestion": "The market question",
      "signal": "BUY_YES" | "BUY_NO" | "HOLD",
      "confidence": 0-100,
      "reasoning": "Why this trade makes sense, citing specific news or data and confirming market is still active",
      "currentPrice": 0.XX,
      "targetPrice": 0.XX,
      "suggestedSize": dollar amount
    }
  ]
}

Only include opportunities where confidence > 70 and signal is not HOLD.
NEVER recommend trades on markets that have already expired or reference past events.
Be selective - it's better to make no trade than a bad trade.`;

/**
 * Analyze markets and find trading opportunities
 */
async function analyzeMarkets(
  runtime: IAgentRuntime,
  service: PolymarketService,
  message: Memory
): Promise<TradeDecision> {
  try {
    // Get current date/time context
    const etTime = getCurrentETTime();

    // Fetch active markets
    const rawMarkets = await service.getMarkets({ active: true, limit: 20 });

    // Filter out expired markets and past-year markets
    const markets = rawMarkets.filter((market) => {
      // Check if market end date has passed
      if (isMarketExpired(market.end_date_iso)) {
        logger.debug({ market: market.question }, '[TradingEvaluator] Skipping expired market');
        return false;
      }

      // Check if market question references a past year
      const pastYearCheck = detectPastYearMarket(market.question, etTime.year);
      if (pastYearCheck.isPast) {
        logger.debug(
          { market: market.question, mentionedYear: pastYearCheck.mentionedYear },
          '[TradingEvaluator] Skipping market referencing past year'
        );
        return false;
      }

      return true;
    });

    logger.info('[TradingEvaluator] Market filtering:', {
      rawCount: rawMarkets.length,
      validCount: markets.length,
      filteredOut: rawMarkets.length - markets.length,
      currentDate: etTime.dateStr,
    });

    // Get portfolio status
    const portfolio = await service.getPortfolio();
    const riskSettings = service.getRiskSettings();

    // Get news context from news provider
    let newsContext = '';
    try {
      const newsResult = await newsProvider.get(runtime, message, undefined);
      newsContext = typeof newsResult === 'string' ? newsResult : newsResult?.text || '';
    } catch (error) {
      logger.debug({ error }, '[TradingEvaluator] Failed to get news context');
      newsContext = '## News Context\nNo recent news available. Analyze based on market data only.';
    }

    // Format markets for analysis with time context
    const marketsText = markets.slice(0, 10).map((m, i) => {
      const yesToken = m.tokens.find(t => t.outcome.toLowerCase() === 'yes');
      const noToken = m.tokens.find(t => t.outcome.toLowerCase() === 'no');
      const timeContext = m.end_date_iso ? getRelativeTimeContext(new Date(m.end_date_iso)) : 'Unknown';
      return `${i + 1}. "${m.question}"
   - Yes: ${((yesToken?.price ?? 0.5) * 100).toFixed(1)}%
   - No: ${((noToken?.price ?? 0.5) * 100).toFixed(1)}%
   - Volume: $${m.volume_num.toLocaleString()}
   - End Date: ${m.end_date_iso} (${timeContext})`;
    }).join('\n\n');

    // Format portfolio
    const portfolioText = `
Total Value: $${portfolio.totalValue.toFixed(2)}
Cash Available: $${portfolio.cashBalance.toFixed(2)}
Unrealized P&L: ${portfolio.unrealizedPnl >= 0 ? '+' : ''}$${portfolio.unrealizedPnl.toFixed(2)}
Open Positions: ${portfolio.positions.length}`;

    const prompt = analysisPrompt
      .replace(/\{\{currentDate\}\}/g, `${etTime.dayOfWeek}, ${etTime.dateStr}`)
      .replace(/\{\{currentTime\}\}/g, etTime.timeStr)
      .replace(/\{\{currentYear\}\}/g, etTime.year.toString())
      .replace('{{portfolio}}', portfolioText)
      .replace('{{maxPositionSize}}', riskSettings.maxPositionSize.toString())
      .replace('{{maxPortfolioRisk}}', riskSettings.maxPortfolioRisk.toString())
      .replace('{{maxDailyLoss}}', riskSettings.maxDailyLoss.toString())
      .replace('{{newsContext}}', newsContext)
      .replace('{{markets}}', marketsText);

    // Get LLM service for analysis
    const llmService = runtime.getService('llm') as LLMService | undefined;
    if (!llmService || !llmService.isAvailable()) {
      logger.warn('[TradingEvaluator] LLM service not available');
      return { shouldTrade: false, opportunities: [], marketAnalysis: 'LLM not available' };
    }

    // Get LLM analysis
    const response = await llmService.generateJSON<{
      shouldTrade: boolean;
      marketAnalysis: string;
      opportunities: Array<{
        marketQuestion: string;
        signal: string;
        confidence: number;
        reasoning: string;
        currentPrice: number;
        targetPrice: number;
        suggestedSize: number;
      }>;
    }>(prompt);

    if (!response || !response.data) {
      return { shouldTrade: false, opportunities: [], marketAnalysis: 'Analysis failed' };
    }

    const analysis = response.data;

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
 * Post trade notification to Twitter if TwitterService is available
 */
async function postTradeToTwitter(
  runtime: IAgentRuntime,
  opportunity: MarketOpportunity,
  result: { success: boolean; message: string; orderId?: string }
): Promise<void> {
  try {
    // Try to get our Twitter service
    const twitterService = runtime.getService('twitter') as TwitterService | undefined;

    if (!twitterService || !twitterService.isAvailable()) {
      logger.debug('[TradingEvaluator] Twitter service not available, skipping notification');
      return;
    }

    const yesToken = opportunity.market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
    const price = opportunity.signal === 'BUY_YES' ? (yesToken?.price ?? 0.5) : (1 - (yesToken?.price ?? 0.5));

    const tweetResult = await twitterService.postTradeNotification({
      market: opportunity.market.question,
      direction: opportunity.signal as 'BUY_YES' | 'BUY_NO',
      amount: opportunity.suggestedSize,
      price,
      confidence: opportunity.confidence,
      reasoning: opportunity.reasoning,
    });

    if (tweetResult) {
      logger.info({ tweetId: tweetResult.id }, '[TradingEvaluator] Trade notification posted to Twitter');
    }
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
 *
 * Uses SignalGeneratorService to aggregate all data sources and generate trading signals.
 */
async function handler(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State
): Promise<void> {
  const polymarketService = runtime.getService<PolymarketService>('polymarket');
  const signalGenerator = runtime.getService<SignalGeneratorService>('signal-generator');
  const strategyLearning = runtime.getService<StrategyLearningService>('strategy-learning');

  if (!polymarketService || polymarketService.isReadOnly()) {
    logger.debug('[TradingEvaluator] Polymarket service not available or read-only');
    return;
  }

  logger.info('[TradingEvaluator] Running autonomous market analysis with full data pipeline...');

  // Use SignalGeneratorService if available, otherwise fall back to basic analysis
  let signals: TradingSignal[] = [];

  if (signalGenerator) {
    logger.info('[TradingEvaluator] Using SignalGenerator with all data sources');
    signals = await signalGenerator.generateSignals();
  } else {
    logger.warn('[TradingEvaluator] SignalGenerator not available, using basic analysis');
    // Fall back to basic analysis
    const decision = await analyzeMarkets(runtime, polymarketService, message);
    if (decision.shouldTrade) {
      signals = decision.opportunities.map((opp) => ({
        id: crypto.randomUUID(),
        market: opp.market,
        direction: opp.signal,
        confidence: opp.confidence,
        edge: 15, // Default edge estimate
        reasoning: opp.reasoning,
        supportingData: { news: [], tweets: [], priceSignals: [] },
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }));
    }
  }

  const config = getConfig();

  logger.info({
    signalCount: signals.length,
    minConfidence: config.minConfidence,
    minComposite: config.minCompositeScore,
    minConsensus: config.minConsensus,
  }, '[TradingEvaluator] Analysis complete - running decision pipeline');

  if (signals.length === 0) {
    logger.info('[TradingEvaluator] No trading signals generated');
    await runtime.setCache(LAST_ANALYSIS_KEY, Date.now().toString());
    return;
  }

  // Get portfolio and risk settings for pipeline
  const portfolio = await polymarketService.getPortfolio();
  const riskSettings = polymarketService.getRiskSettings();

  // Run each signal through the decision pipeline
  const pipelineResults: PipelineDecision[] = [];
  for (const signal of signals) {
    const decision = runDecisionPipeline(signal, portfolio, riskSettings, config);
    pipelineResults.push(decision);

    logger.debug({
      market: signal.market.question.slice(0, 50),
      stage: decision.stage,
      approved: decision.approved,
      reason: decision.reason,
    }, '[TradingEvaluator] Pipeline decision');
  }

  // Get approved trades
  const approvedTrades = pipelineResults.filter(d => d.approved);
  const rejectedTrades = pipelineResults.filter(d => !d.approved);

  logger.info({
    total: signals.length,
    approved: approvedTrades.length,
    rejected: rejectedTrades.length,
    rejectionReasons: rejectedTrades.slice(0, 5).map(d => ({
      stage: d.stage,
      reason: d.reason,
    })),
  }, '[TradingEvaluator] Pipeline summary');

  // Limit concurrent trades
  const tradesToExecute = approvedTrades.slice(0, config.maxConcurrentTrades);

  for (const decision of tradesToExecute) {
    const signal = decision.signal;
    const suggestedSize = decision.adjustedSize || 25; // Use Kelly-optimized size

    // Convert signal to opportunity format
    const opportunity: MarketOpportunity = {
      market: signal.market,
      signal: signal.direction,
      confidence: signal.confidence,
      reasoning: signal.reasoning,
      suggestedSize,
      factors: signal.factors,
    };

    logger.info({
      market: signal.market.question,
      direction: signal.direction,
      confidence: signal.confidence,
      edge: signal.edge,
      size: suggestedSize,
      riskScore: decision.riskScore,
      kellySize: decision.kellySize,
      factors: signal.factors ? {
        composite: signal.factors.compositeScore,
        consensus: signal.factors.consensusScore,
        freshness: (signal.factors.timeDecay * 100).toFixed(0) + '%',
      } : null,
      supportingData: {
        newsCount: signal.supportingData.news?.length || 0,
        tweetCount: signal.supportingData.tweets?.length || 0,
        priceSignalCount: signal.supportingData.priceSignals?.length || 0,
        webSignalCount: signal.supportingData.webSignals?.length || 0,
      },
    }, '[TradingEvaluator] Executing trade - pipeline approved');

    const result = await executeTrade(polymarketService, opportunity);

    if (result.success) {
      logger.info({ orderId: result.orderId }, '[TradingEvaluator] Trade executed');

      // Record signal entry for performance tracking
      if (signalGenerator) {
        const yesPrice = signal.market.tokens.find((t) => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
        signalGenerator.recordSignalEntry(signal, yesPrice);
      }

      // Record trade in strategy learning service for long-term performance tracking
      if (strategyLearning) {
        const yesPrice = signal.market.tokens.find((t) => t.outcome.toLowerCase() === 'yes')?.price || 0.5;
        const entryPrice = signal.direction === 'BUY_YES' ? yesPrice : (1 - yesPrice);

        // Convert supporting data to DataSignalRecord format
        const dataSignals: DataSignalRecord[] = [
          ...signal.supportingData.news.map((n) => ({
            source: n.source || 'News',
            type: 'news' as const,
            signal: n.title,
            sentiment: (n.sentiment === 'positive' ? 'bullish' : n.sentiment === 'negative' ? 'bearish' : 'neutral') as 'bullish' | 'bearish' | 'neutral',
            strength: n.relevanceScore || 50,
            timestamp: n.publishedAt,
          })),
          ...signal.supportingData.tweets.map((t) => ({
            source: `@${t.tweet.authorUsername}`,
            type: 'social' as const,
            signal: t.tweet.text.slice(0, 200),
            sentiment: t.sentiment as 'bullish' | 'bearish' | 'neutral',
            strength: Math.min(100, Math.log10(t.tweet.authorFollowers + 1) * 20),
            timestamp: t.tweet.createdAt,
          })),
          ...signal.supportingData.priceSignals.map((p) => ({
            source: p.source,
            type: 'price' as const,
            signal: p.summary,
            sentiment: p.direction as 'bullish' | 'bearish' | 'neutral',
            strength: p.strength,
            timestamp: p.timestamp,
          })),
          ...(signal.supportingData.webSignals || []).map((w) => ({
            source: 'Tavily',
            type: 'web' as const,
            signal: w.summary,
            sentiment: w.direction as 'bullish' | 'bearish' | 'neutral',
            strength: w.strength,
            timestamp: w.timestamp,
          })),
        ];

        strategyLearning.recordTradeEntry({
          marketId: signal.market.condition_id,
          marketQuestion: signal.market.question,
          direction: signal.direction as 'BUY_YES' | 'BUY_NO',
          entryPrice,
          size: suggestedSize,
          dataSignals,
          reasoning: signal.reasoning,
          pipelineMetadata: {
            riskScore: decision.riskScore,
            kellySize: decision.kellySize,
            factors: signal.factors,
          },
        });

        logger.info('[TradingEvaluator] Trade recorded in strategy learning service');
      }

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
            market: signal.market.question,
            signal: signal.direction,
            confidence: signal.confidence,
            edge: signal.edge,
            reasoning: signal.reasoning,
            orderId: result.orderId,
            pipelineData: {
              riskScore: decision.riskScore,
              kellySize: decision.kellySize,
              adjustedSize: decision.adjustedSize,
            },
            factors: signal.factors ? {
              composite: signal.factors.compositeScore,
              consensus: signal.factors.consensusScore,
              news: signal.factors.newsScore,
              social: signal.factors.socialScore,
              webSearch: signal.factors.webSearchScore,
              volume: signal.factors.volumeScore,
              freshness: signal.factors.timeDecay,
            } : null,
            supportingDataSummary: {
              newsItems: signal.supportingData.news?.length || 0,
              tweets: signal.supportingData.tweets?.length || 0,
              priceSignals: signal.supportingData.priceSignals?.length || 0,
              webSignals: signal.supportingData.webSignals?.length || 0,
            },
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
          market: signal.market.question,
          signal: signal.direction,
          confidence: signal.confidence,
          edge: signal.edge,
          reasoning: signal.reasoning,
          orderId: result.orderId,
          message: result.message,
          supportingData: signal.supportingData,
        },
      });
    } else {
      logger.warn({ error: result.message }, '[TradingEvaluator] Trade failed');
    }
  }

  await runtime.setCache(LAST_ANALYSIS_KEY, Date.now().toString());
}

/**
 * Format trade for Twitter post - professional, no emojis or hashtags
 */
function formatTradeForTwitter(
  opportunity: MarketOpportunity,
  result: { success: boolean; message: string; orderId?: string }
): string {
  const outcome = opportunity.signal === 'BUY_YES' ? 'YES' : 'NO';
  const price = opportunity.market.tokens.find(t => t.outcome.toLowerCase() === outcome.toLowerCase())?.price ?? 0.5;

  // Clean reasoning of any emojis
  const cleanReasoning = opportunity.reasoning
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .slice(0, 150);

  return `New Position: ${outcome} @ ${(price * 100).toFixed(0)}%

"${opportunity.market.question.slice(0, 80)}${opportunity.market.question.length > 80 ? '...' : ''}"

Size: $${opportunity.suggestedSize.toFixed(0)} | Confidence: ${opportunity.confidence}%

Thesis: ${cleanReasoning}${opportunity.reasoning.length > 150 ? '...' : ''}`;
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
