/**
 * Technical Analysis Service
 *
 * Comprehensive technical analysis engine with all major indicators:
 * - Trend: SMA, EMA, ADX
 * - Momentum: RSI, MACD, Stochastic
 * - Volatility: Bollinger Bands, ATR
 * - Support/Resistance: Pivot Points
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import type { OHLCCandle } from './coingecko-data.service';

// ============= Types =============

export interface TechnicalIndicators {
  // Current price
  currentPrice: number;

  // Trend Indicators
  sma20: number;
  sma50: number;
  sma200: number;
  ema12: number;
  ema26: number;

  // Momentum Indicators
  rsi14: number;
  macd: { line: number; signal: number; histogram: number };
  stochastic: { k: number; d: number };

  // Volatility Indicators
  bollingerBands: { upper: number; middle: number; lower: number; width: number };
  atr14: number;
  volatility30d: number;

  // Support/Resistance
  pivotPoints: { r2: number; r1: number; pivot: number; s1: number; s2: number };

  // Trend Assessment
  adx: number;
  trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trendStrength: 'STRONG' | 'MODERATE' | 'WEAK';

  // Price position
  priceVsSMA20: number;  // % above/below SMA20
  priceVsSMA50: number;
  bbPosition: number;    // -1 = below lower, 0 = middle, 1 = above upper
}

export interface PriceProjection {
  targetPrice: number;
  currentPrice: number;
  direction: 'ABOVE' | 'BELOW';
  probability: number;
  timeframeHours: number;
  confidence: number;
  supportingIndicators: string[];
  contradictingIndicators: string[];
}

// ============= Service =============

export class TechnicalAnalysisService extends Service {
  static readonly serviceType = 'technical-analysis';
  readonly capabilityDescription = 'Performs comprehensive technical analysis on crypto assets';

  static async start(runtime: IAgentRuntime): Promise<TechnicalAnalysisService> {
    const service = new TechnicalAnalysisService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[TechnicalAnalysis] Service initialized');
  }

  async stop(): Promise<void> {
    logger.info('[TechnicalAnalysis] Service stopped');
  }

  // ============= Moving Averages =============

  /**
   * Simple Moving Average
   */
  calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) {
      return prices.length > 0 ? prices[prices.length - 1] : 0;
    }
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Exponential Moving Average
   */
  calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    if (prices.length < period) return this.calculateSMA(prices, prices.length);

    const multiplier = 2 / (period + 1);
    let ema = this.calculateSMA(prices.slice(0, period), period);

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  // ============= Momentum Indicators =============

  /**
   * Relative Strength Index (RSI)
   */
  calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate subsequent values using Wilder's smoothing
    for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
      }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * MACD (Moving Average Convergence Divergence)
   */
  calculateMACD(prices: number[]): { line: number; signal: number; histogram: number } {
    if (prices.length < 26) {
      return { line: 0, signal: 0, histogram: 0 };
    }

    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);
    const macdLine = ema12 - ema26;

    // Calculate MACD values for signal line
    const macdValues: number[] = [];
    for (let i = 26; i <= prices.length; i++) {
      const e12 = this.calculateEMA(prices.slice(0, i), 12);
      const e26 = this.calculateEMA(prices.slice(0, i), 26);
      macdValues.push(e12 - e26);
    }

    const signalLine = macdValues.length >= 9
      ? this.calculateEMA(macdValues, 9)
      : macdLine;

    const histogram = macdLine - signalLine;

    return { line: macdLine, signal: signalLine, histogram };
  }

  /**
   * Stochastic Oscillator
   */
  calculateStochastic(candles: OHLCCandle[], kPeriod: number = 14, dPeriod: number = 3): { k: number; d: number } {
    if (candles.length < kPeriod) return { k: 50, d: 50 };

    // Calculate %K values
    const kValues: number[] = [];
    for (let i = kPeriod - 1; i < candles.length; i++) {
      const slice = candles.slice(i - kPeriod + 1, i + 1);
      const highestHigh = Math.max(...slice.map(c => c.high));
      const lowestLow = Math.min(...slice.map(c => c.low));
      const currentClose = candles[i].close;

      if (highestHigh === lowestLow) {
        kValues.push(50);
      } else {
        kValues.push(((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100);
      }
    }

    const k = kValues[kValues.length - 1];

    // Calculate %D (SMA of %K)
    const d = kValues.length >= dPeriod
      ? kValues.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod
      : k;

    return { k, d };
  }

  // ============= Volatility Indicators =============

  /**
   * Bollinger Bands
   */
  calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2): {
    upper: number; middle: number; lower: number; width: number;
  } {
    if (prices.length < period) {
      const p = prices[prices.length - 1] || 0;
      return { upper: p, middle: p, lower: p, width: 0 };
    }

    const sma = this.calculateSMA(prices, period);
    const slice = prices.slice(-period);

    // Calculate standard deviation
    const squaredDiffs = slice.map(p => Math.pow(p - sma, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(variance);

    const upper = sma + (stdDev * sd);
    const lower = sma - (stdDev * sd);
    const width = sma > 0 ? (upper - lower) / sma : 0; // Normalized width

    return { upper, middle: sma, lower, width };
  }

  /**
   * Average True Range (ATR)
   */
  calculateATR(candles: OHLCCandle[], period: number = 14): number {
    if (candles.length < 2) return 0;

    const trueRanges: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    if (trueRanges.length < period) {
      return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    }

    // Use Wilder's smoothing
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < trueRanges.length; i++) {
      atr = ((atr * (period - 1)) + trueRanges[i]) / period;
    }

    return atr;
  }

  /**
   * 30-Day Annualized Volatility
   */
  calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        returns.push(Math.log(prices[i] / prices[i - 1]));
      }
    }

    if (returns.length === 0) return 0;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const squaredDiffs = returns.map(r => Math.pow(r - avgReturn, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / returns.length;

    // Annualize (assuming daily data, 365 days)
    return Math.sqrt(variance * 365) * 100;
  }

  // ============= Support/Resistance =============

  /**
   * Pivot Points
   */
  calculatePivotPoints(candles: OHLCCandle[]): {
    r2: number; r1: number; pivot: number; s1: number; s2: number;
  } {
    if (candles.length === 0) {
      return { r2: 0, r1: 0, pivot: 0, s1: 0, s2: 0 };
    }

    const lastCandle = candles[candles.length - 1];
    const high = lastCandle.high;
    const low = lastCandle.low;
    const close = lastCandle.close;

    const pivot = (high + low + close) / 3;
    const r1 = (2 * pivot) - low;
    const s1 = (2 * pivot) - high;
    const r2 = pivot + (high - low);
    const s2 = pivot - (high - low);

    return { r2, r1, pivot, s1, s2 };
  }

  // ============= Trend Indicators =============

  /**
   * Average Directional Index (ADX) - Trend Strength
   */
  calculateADX(candles: OHLCCandle[], period: number = 14): number {
    if (candles.length < period * 2) return 25; // Default neutral

    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const highDiff = candles[i].high - candles[i - 1].high;
      const lowDiff = candles[i - 1].low - candles[i].low;

      plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
      minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

      const trueRange = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      tr.push(trueRange);
    }

    // Wilder's smoothing
    const smoothTR = this.wilderSmooth(tr, period);
    const smoothPlusDM = this.wilderSmooth(plusDM, period);
    const smoothMinusDM = this.wilderSmooth(minusDM, period);

    if (smoothTR === 0) return 25;

    const plusDI = (smoothPlusDM / smoothTR) * 100;
    const minusDI = (smoothMinusDM / smoothTR) * 100;

    if (plusDI + minusDI === 0) return 25;

    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;

    return dx;
  }

  private wilderSmooth(values: number[], period: number): number {
    if (values.length < period) {
      return values.reduce((a, b) => a + b, 0) / values.length;
    }

    let smooth = values.slice(0, period).reduce((a, b) => a + b, 0);
    for (let i = period; i < values.length; i++) {
      smooth = smooth - (smooth / period) + values[i];
    }
    return smooth / period;
  }

  // ============= Full Analysis =============

  /**
   * Perform comprehensive technical analysis
   */
  analyzeAsset(candles: OHLCCandle[], prices?: number[]): TechnicalIndicators {
    const closes = candles.map(c => c.close);
    const currentPrice = closes.length > 0 ? closes[closes.length - 1] : 0;

    // Use provided prices array if available (higher granularity)
    const priceArray = prices && prices.length > closes.length ? prices : closes;

    // Moving Averages
    const sma20 = this.calculateSMA(priceArray, 20);
    const sma50 = this.calculateSMA(priceArray, 50);
    const sma200 = this.calculateSMA(priceArray, Math.min(200, priceArray.length));
    const ema12 = this.calculateEMA(priceArray, 12);
    const ema26 = this.calculateEMA(priceArray, 26);

    // Momentum
    const rsi14 = this.calculateRSI(priceArray, 14);
    const macd = this.calculateMACD(priceArray);
    const stochastic = this.calculateStochastic(candles);

    // Volatility
    const bollingerBands = this.calculateBollingerBands(priceArray);
    const atr14 = this.calculateATR(candles, 14);
    const volatility30d = this.calculateVolatility(priceArray);

    // Support/Resistance
    const pivotPoints = this.calculatePivotPoints(candles);

    // Trend
    const adx = this.calculateADX(candles);

    // Determine trend direction
    let trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (currentPrice > sma20 && sma20 > sma50 && macd.histogram > 0) {
      trendDirection = 'BULLISH';
    } else if (currentPrice < sma20 && sma20 < sma50 && macd.histogram < 0) {
      trendDirection = 'BEARISH';
    }

    // Determine trend strength
    let trendStrength: 'STRONG' | 'MODERATE' | 'WEAK' = 'WEAK';
    if (adx > 40) trendStrength = 'STRONG';
    else if (adx > 25) trendStrength = 'MODERATE';

    // Price position relative to MAs
    const priceVsSMA20 = sma20 > 0 ? ((currentPrice - sma20) / sma20) * 100 : 0;
    const priceVsSMA50 = sma50 > 0 ? ((currentPrice - sma50) / sma50) * 100 : 0;

    // Bollinger Band position
    let bbPosition = 0;
    if (currentPrice > bollingerBands.upper) bbPosition = 1;
    else if (currentPrice < bollingerBands.lower) bbPosition = -1;

    return {
      currentPrice,
      sma20, sma50, sma200, ema12, ema26,
      rsi14, macd, stochastic,
      bollingerBands, atr14, volatility30d,
      pivotPoints, adx,
      trendDirection, trendStrength,
      priceVsSMA20, priceVsSMA50, bbPosition
    };
  }

  // ============= Price Projection =============

  /**
   * Project probability of reaching a price target
   */
  projectPriceTarget(
    currentPrice: number,
    targetPrice: number,
    indicators: TechnicalIndicators,
    daysToExpiry: number
  ): PriceProjection {
    const isAboveTarget = targetPrice > currentPrice;
    const direction: 'ABOVE' | 'BELOW' = isAboveTarget ? 'ABOVE' : 'BELOW';
    const priceDistance = Math.abs(targetPrice - currentPrice) / currentPrice;
    const supportingIndicators: string[] = [];
    const contradictingIndicators: string[] = [];

    let baseProbability = 0.5;

    // ===== RSI Analysis =====
    if (isAboveTarget) {
      if (indicators.rsi14 < 30) {
        baseProbability += 0.15;
        supportingIndicators.push(`RSI Oversold (${indicators.rsi14.toFixed(1)})`);
      } else if (indicators.rsi14 > 70) {
        baseProbability -= 0.10;
        contradictingIndicators.push(`RSI Overbought (${indicators.rsi14.toFixed(1)})`);
      }
    } else {
      if (indicators.rsi14 > 70) {
        baseProbability += 0.15;
        supportingIndicators.push(`RSI Overbought (${indicators.rsi14.toFixed(1)})`);
      } else if (indicators.rsi14 < 30) {
        baseProbability -= 0.10;
        contradictingIndicators.push(`RSI Oversold (${indicators.rsi14.toFixed(1)})`);
      }
    }

    // ===== MACD Analysis =====
    if (isAboveTarget && indicators.macd.histogram > 0) {
      baseProbability += 0.10;
      supportingIndicators.push('MACD Bullish');
    } else if (!isAboveTarget && indicators.macd.histogram < 0) {
      baseProbability += 0.10;
      supportingIndicators.push('MACD Bearish');
    } else if (isAboveTarget && indicators.macd.histogram < 0) {
      baseProbability -= 0.08;
      contradictingIndicators.push('MACD Bearish');
    } else if (!isAboveTarget && indicators.macd.histogram > 0) {
      baseProbability -= 0.08;
      contradictingIndicators.push('MACD Bullish');
    }

    // ===== Trend Analysis =====
    if (isAboveTarget && indicators.trendDirection === 'BULLISH') {
      const bonus = indicators.trendStrength === 'STRONG' ? 0.15 : 0.08;
      baseProbability += bonus;
      supportingIndicators.push(`${indicators.trendStrength} Bullish Trend`);
    } else if (!isAboveTarget && indicators.trendDirection === 'BEARISH') {
      const bonus = indicators.trendStrength === 'STRONG' ? 0.15 : 0.08;
      baseProbability += bonus;
      supportingIndicators.push(`${indicators.trendStrength} Bearish Trend`);
    } else if (isAboveTarget && indicators.trendDirection === 'BEARISH') {
      baseProbability -= 0.10;
      contradictingIndicators.push('Bearish Trend');
    } else if (!isAboveTarget && indicators.trendDirection === 'BULLISH') {
      baseProbability -= 0.10;
      contradictingIndicators.push('Bullish Trend');
    }

    // ===== Bollinger Bands Position =====
    if (isAboveTarget && indicators.bbPosition < 0) {
      baseProbability += 0.12;
      supportingIndicators.push('Price Below Lower BB');
    } else if (!isAboveTarget && indicators.bbPosition > 0) {
      baseProbability += 0.12;
      supportingIndicators.push('Price Above Upper BB');
    }

    // ===== Stochastic =====
    if (isAboveTarget && indicators.stochastic.k < 20) {
      baseProbability += 0.08;
      supportingIndicators.push('Stochastic Oversold');
    } else if (!isAboveTarget && indicators.stochastic.k > 80) {
      baseProbability += 0.08;
      supportingIndicators.push('Stochastic Overbought');
    }

    // ===== Distance Penalty =====
    const distancePenalty = Math.min(priceDistance * 2, 0.30);
    baseProbability -= distancePenalty;

    // ===== Time Bonus =====
    const timeBonus = Math.min(daysToExpiry / 100, 0.15);
    baseProbability += timeBonus;

    // ===== Volatility Adjustment =====
    const dailyVol = indicators.volatility30d / 100 / Math.sqrt(365);
    const expectedMove = dailyVol * Math.sqrt(daysToExpiry);
    if (priceDistance < expectedMove) {
      baseProbability += 0.10;
      supportingIndicators.push('Within Expected Move');
    } else if (priceDistance > expectedMove * 2) {
      baseProbability -= 0.10;
      contradictingIndicators.push('Beyond 2x Expected Move');
    }

    // Clamp probability
    const probability = Math.max(0.05, Math.min(0.95, baseProbability));

    // Calculate confidence based on indicator alignment
    const indicatorScore = supportingIndicators.length - (contradictingIndicators.length * 0.5);
    const confidence = Math.max(20, Math.min(90, 40 + indicatorScore * 10));

    return {
      targetPrice,
      currentPrice,
      direction,
      probability,
      timeframeHours: daysToExpiry * 24,
      confidence,
      supportingIndicators,
      contradictingIndicators
    };
  }
}
