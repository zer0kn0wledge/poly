/**
 * Lightweight LLM Service
 *
 * Uses the Anthropic API directly via fetch to avoid dependency issues.
 * Provides structured output parsing for trading decisions.
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface StructuredResponse<T> {
  data: T;
  raw: string;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export class LLMService extends Service {
  static override readonly serviceType = 'llm';
  override capabilityDescription = 'Provides LLM capabilities via Anthropic API';

  private runtime: IAgentRuntime | null = null;
  private apiKey: string | null = null;
  private model = 'claude-sonnet-4-20250514';

  constructor() {
    super();
  }

  override async initialize(runtime: IAgentRuntime): Promise<void> {
    logger.info('[LLM] Initializing LLM service');
    this.runtime = runtime;
    this.apiKey = process.env.ANTHROPIC_API_KEY || null;

    if (!this.apiKey) {
      logger.warn('[LLM] No ANTHROPIC_API_KEY found - LLM features will be disabled');
    } else {
      logger.info('[LLM] Anthropic API configured successfully');
    }
  }

  override async stop(): Promise<void> {
    logger.info('[LLM] Stopping LLM service');
  }

  /**
   * Check if LLM is available
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Generate a text response
   */
  async generate(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('LLM not available - ANTHROPIC_API_KEY not set');
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature ?? 0.7,
        messages: [
          { role: 'user', content: prompt }
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, '[LLM] API request failed');
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    return {
      text: data.content[0]?.text || '',
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
    };
  }

  /**
   * Generate a structured JSON response
   */
  async generateJSON<T>(prompt: string, options?: { maxTokens?: number }): Promise<StructuredResponse<T>> {
    const systemPrompt = `${prompt}

IMPORTANT: Respond with valid JSON only. No markdown, no code blocks, no explanation - just the JSON object.`;

    const response = await this.generate(systemPrompt, {
      maxTokens: options?.maxTokens || 4096,
      temperature: 0.3, // Lower temperature for structured output
    });

    // Try to parse the JSON
    let parsed: T;
    try {
      // Clean up common issues
      let cleanedText = response.text.trim();

      // Remove markdown code blocks if present
      if (cleanedText.startsWith('```json')) {
        cleanedText = cleanedText.slice(7);
      } else if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.slice(3);
      }
      if (cleanedText.endsWith('```')) {
        cleanedText = cleanedText.slice(0, -3);
      }
      cleanedText = cleanedText.trim();

      parsed = JSON.parse(cleanedText) as T;
    } catch (e) {
      logger.error({ error: e, text: response.text }, '[LLM] Failed to parse JSON response');
      throw new Error(`Failed to parse LLM response as JSON: ${e}`);
    }

    return {
      data: parsed,
      raw: response.text,
    };
  }

  /**
   * Analyze trading opportunity
   */
  async analyzeMarket(context: {
    market: { question: string; yesPrice: number; noPrice: number; volume: number; endDate: string };
    newsContext: string;
    portfolio: { totalValue: number; cashBalance: number };
    riskSettings: { maxPositionSize: number; maxPortfolioRisk: number };
  }): Promise<{
    signal: 'BUY_YES' | 'BUY_NO' | 'HOLD';
    confidence: number;
    reasoning: string;
    suggestedSize: number;
    edge: number;
  }> {
    const prompt = `You are an expert prediction market trader analyzing a Polymarket opportunity.

MARKET:
Question: "${context.market.question}"
Current YES price: ${(context.market.yesPrice * 100).toFixed(1)}%
Current NO price: ${(context.market.noPrice * 100).toFixed(1)}%
Trading volume: $${context.market.volume.toLocaleString()}
Resolution date: ${context.market.endDate}

PORTFOLIO:
Total value: $${context.portfolio.totalValue.toFixed(2)}
Cash available: $${context.portfolio.cashBalance.toFixed(2)}

RISK LIMITS:
Max position size: $${context.riskSettings.maxPositionSize}
Max portfolio risk: $${context.riskSettings.maxPortfolioRisk}

NEWS & CONTEXT:
${context.newsContext}

ANALYSIS TASK:
1. Estimate the TRUE probability based on all available information
2. Compare your estimate to the current market price
3. Identify if there's a tradeable edge (>10% difference)
4. Recommend a trade only if confidence is high (>70%)

Respond with JSON:
{
  "signal": "BUY_YES" | "BUY_NO" | "HOLD",
  "confidence": <0-100>,
  "reasoning": "<detailed reasoning citing specific data>",
  "suggestedSize": <dollar amount, max ${context.riskSettings.maxPositionSize}>,
  "edge": <estimated edge in percentage points>,
  "estimatedProbability": <your probability estimate 0-100>
}`;

    const response = await this.generateJSON<{
      signal: 'BUY_YES' | 'BUY_NO' | 'HOLD';
      confidence: number;
      reasoning: string;
      suggestedSize: number;
      edge: number;
    }>(prompt);

    return response.data;
  }
}

export const llmService = new LLMService();
