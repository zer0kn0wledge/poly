/**
 * Polymarket Trading Agent Project
 *
 * This file exports the project configuration that can be used to run
 * the Polymarket trading agent as a standalone ElizaOS project.
 */

import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import { character } from './character';
import { polymarketPlugin } from './plugin';

/**
 * Initialize the Polymarket trading agent
 */
const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info('[PolyTrader] Initializing Polymarket trading agent');
  logger.info({ name: character.name }, '[PolyTrader] Agent name:');

  // Log configuration
  const config = {
    autoTrade: process.env.POLYMARKET_AUTO_TRADE === 'true',
    analysisInterval: parseInt(process.env.POLYMARKET_ANALYSIS_INTERVAL || '300000'),
    minConfidence: parseInt(process.env.POLYMARKET_MIN_CONFIDENCE || '75'),
    maxPositionSize: parseFloat(process.env.POLYMARKET_MAX_POSITION_SIZE || '50'),
    hasPrivateKey: !!process.env.POLYMARKET_PRIVATE_KEY,
    hasTwitter: !!(process.env.TWITTER_API_KEY && process.env.TWITTER_ACCESS_TOKEN),
    hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
  };

  logger.info({ config }, '[PolyTrader] Configuration:');

  if (!config.hasPrivateKey) {
    logger.warn('[PolyTrader] No private key configured - running in read-only mode');
  }

  if (!config.hasTwitter) {
    logger.warn('[PolyTrader] Twitter not configured - trade notifications disabled');
  }

  if (!config.hasAnthropic) {
    logger.error('[PolyTrader] No Anthropic API key - LLM features will not work');
  }
};

/**
 * Project agent configuration
 */
export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  plugins: [polymarketPlugin],
};

/**
 * Project configuration
 */
const project: Project = {
  agents: [projectAgent],
};

export { character } from './character';
export { polymarketPlugin } from './plugin';

export default project;
