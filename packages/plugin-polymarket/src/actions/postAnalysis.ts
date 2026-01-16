/**
 * POST_ANALYSIS Action - CRYPTO PRICE ANALYSIS ONLY
 *
 * Posts crypto price prediction analysis to Twitter.
 * Uses CoinGecko technical analysis data to generate informed posts.
 * NO politics, NO sports - ONLY crypto price predictions.
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
import { TwitterService } from '../services/twitter';
import { EdgeCalculatorService, type TradingOpportunity } from '../services/edge-calculator.service';
import { CoinGeckoDataService } from '../services/coingecko-data.service';
import { CryptoMarketDiscoveryService } from '../services/crypto-market-discovery.service';

/**
 * Sanitize text - remove emojis, hashtags, and XML tags.
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
    .replace(/<[^>]*>/g, '')  // Remove XML/HTML tags
    .replace(/#\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect which crypto the user wants to post about
 */
function detectCrypto(text: string): string | null {
  const lowerText = text.toLowerCase();
  const coinMap: Record<string, string> = {
    'bitcoin': 'bitcoin',
    'btc': 'bitcoin',
    'ethereum': 'ethereum',
    'eth': 'ethereum',
    'solana': 'solana',
    'sol': 'solana',
    'doge': 'dogecoin',
    'dogecoin': 'dogecoin',
    'xrp': 'ripple',
    'cardano': 'cardano',
    'ada': 'cardano',
    'bnb': 'binancecoin',
    'avax': 'avalanche-2',
  };

  for (const [keyword, coinId] of Object.entries(coinMap)) {
    if (lowerText.includes(keyword)) {
      return coinId;
    }
  }
  return null;
}

export const postAnalysisAction: Action = {
  name: 'POST_ANALYSIS',
  similes: [
    'POST_TO_TWITTER',
    'TWEET_ANALYSIS',
    'SHARE_ANALYSIS',
    'TWITTER_UPDATE',
    'TWEET_MARKETS',
    'SEND_TWEET',
    'PUBLISH_TWEET',
    'TWITTER_POST',
    'MAKE_TWEET',
    'POST_CRYPTO',
    'TWEET_CRYPTO',
  ],
  description: 'Post crypto price prediction analysis to Twitter',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';

    const twitterTriggers = [
      'tweet', 'twitter', 'post this', 'share this', 'post it',
      'share it', 'send to twitter', 'post on x', 'share on x',
      'post analysis', 'tweet analysis', 'can you tweet', 'can you post',
      'please tweet', 'please post', 'make a tweet', 'send tweet',
      'publish', 'post to', 'share to', 'tweet about', 'post about'
    ];

    const shouldTrigger = twitterTriggers.some((t) => text.includes(t));

    if (shouldTrigger) {
      logger.info('[POST_ANALYSIS] Validation PASSED - twitter request detected');
    }

    return shouldTrigger;
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
      const twitterService = runtime.getService<TwitterService>('twitter');
      const edgeCalculator = runtime.getService<EdgeCalculatorService>('edge-calculator');
      const coinGeckoService = runtime.getService<CoinGeckoDataService>('coingecko-data');
      const discoveryService = runtime.getService<CryptoMarketDiscoveryService>('crypto-market-discovery');

      if (!twitterService?.isAvailable()) {
        const errorMsg = 'Twitter service not available. Please check Twitter API credentials.';
        if (callback) await callback({ text: errorMsg, error: true });
        return { success: false, error: errorMsg };
      }

      const text = message.content.text || '';
      const targetCoin = detectCrypto(text);

      logger.info({ targetCoin }, '[POST_ANALYSIS] Processing crypto analysis post');

      if (callback) {
        await callback({ text: `Preparing crypto price analysis${targetCoin ? ` for ${targetCoin}` : ''}...` });
      }

      let tweetContent: string | null = null;

      // Try to get edge-calculated opportunities for richer content
      if (edgeCalculator) {
        try {
          const opportunities = await edgeCalculator.findOpportunities();
          let targetOpp: TradingOpportunity | undefined;

          if (targetCoin) {
            targetOpp = opportunities.find(o => o.market.coin === targetCoin);
          } else {
            // Get best opportunity
            targetOpp = opportunities.find(o => o.rating === 'STRONG_BUY' || o.rating === 'BUY');
          }

          if (targetOpp) {
            tweetContent = formatOpportunityTweet(targetOpp);
          }
        } catch (error) {
          logger.warn({ error: String(error) }, '[POST_ANALYSIS] Edge calculator not available');
        }
      }

      // Fallback: generate from CoinGecko data directly
      if (!tweetContent && coinGeckoService) {
        const coin = targetCoin || 'bitcoin';
        try {
          const analysisData = await coinGeckoService.getFullAnalysisData(coin);
          if (analysisData) {
            tweetContent = formatPriceTweet(coin, analysisData);
          }
        } catch (error) {
          logger.warn({ error: String(error) }, '[POST_ANALYSIS] CoinGecko fetch failed');
        }
      }

      // Last resort: simple market listing
      if (!tweetContent && discoveryService) {
        try {
          const markets = await discoveryService.getCryptoPriceMarkets(1000, 5000);
          const market = targetCoin
            ? markets.find(m => m.coin === targetCoin)
            : markets[0];

          if (market) {
            tweetContent = `${market.coinSymbol} Price Market\n\n`;
            tweetContent += `Target: $${market.targetPrice.toLocaleString()}\n`;
            tweetContent += `Market odds: ${(market.yesPrice * 100).toFixed(0)}% YES\n`;
            tweetContent += `Volume: $${(market.volume / 1000).toFixed(0)}K\n`;
            tweetContent += `Expires: ${market.daysToExpiry.toFixed(0)} days`;
          }
        } catch (error) {
          logger.warn({ error: String(error) }, '[POST_ANALYSIS] Discovery failed');
        }
      }

      if (!tweetContent) {
        const errorMsg = 'Could not generate crypto analysis. Please try again.';
        if (callback) await callback({ text: errorMsg, error: true });
        return { success: false, error: errorMsg };
      }

      // Sanitize and post
      tweetContent = sanitizeText(tweetContent).slice(0, 280);

      const result = await twitterService.tweet(tweetContent);

      if (result) {
        const successMsg = `Posted to Twitter successfully.\n\nTweet: ${tweetContent}\n\nURL: ${result.url}`;
        if (callback) {
          await callback({
            text: successMsg,
            action: 'POST_ANALYSIS',
          });
        }
        return {
          success: true,
          text: successMsg,
          data: { tweetId: result.id, url: result.url },
        };
      } else {
        const errorMsg = 'Failed to post to Twitter. Please try again.';
        if (callback) await callback({ text: errorMsg, error: true });
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      const errorMsg = `Post failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.error({ error }, '[POST_ANALYSIS] Error');

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
        content: { text: 'Tweet about BTC markets' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Posted to Twitter successfully.\n\nTweet: BTC at $97,500 | RSI 58 | MACD bullish\n$100k target market: 65% YES\nEdge: +8% based on TA\nTrend: BULLISH\n\nURL: https://twitter.com/i/status/1234567890',
          action: 'POST_ANALYSIS',
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: { text: 'Post crypto analysis to Twitter' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Posted to Twitter successfully.\n\nTweet: ETH Price Analysis\nCurrent: $3,650 | Target: $4,000\nRSI: 62 (neutral) | MACD: bullish\nMarket: 45% YES | Model: 52%\nEdge: +7%\n\nURL: https://twitter.com/i/status/1234567891',
          action: 'POST_ANALYSIS',
        },
      },
    ],
  ],
};

/**
 * Format opportunity into tweet
 */
function formatOpportunityTweet(opp: TradingOpportunity): string {
  const coin = opp.market.coinSymbol;
  const price = opp.currentPrice.toLocaleString();
  const target = opp.targetPrice.toLocaleString();
  const ta = opp.technicalAnalysis;
  const edgePct = opp.edge > 0 ? `+${opp.edgePercent.toFixed(0)}` : opp.edgePercent.toFixed(0);

  let tweet = `${coin} at $${price}\n\n`;
  tweet += `Target: $${target}\n`;
  tweet += `RSI: ${ta.rsi.toFixed(0)} | MACD: ${ta.macdSignal}\n`;
  tweet += `Market: ${(opp.marketImpliedProbability * 100).toFixed(0)}% | Model: ${(opp.estimatedProbability * 100).toFixed(0)}%\n`;
  tweet += `Edge: ${edgePct}% on ${opp.side}\n`;
  tweet += `Rating: ${opp.rating}`;

  return tweet;
}

/**
 * Format CoinGecko data into tweet
 */
function formatPriceTweet(coinId: string, data: { price: { usd: number; usd_24h_change: number } }): string {
  const symbol = coinId.toUpperCase().slice(0, 3);
  const price = data.price.usd.toLocaleString();
  const change = data.price.usd_24h_change;
  const changeStr = change >= 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}%`;

  let tweet = `${symbol} Price Update\n\n`;
  tweet += `Current: $${price}\n`;
  tweet += `24h Change: ${changeStr}\n\n`;
  tweet += `Analyzing Polymarket price targets...`;

  return tweet;
}

export default postAnalysisAction;
