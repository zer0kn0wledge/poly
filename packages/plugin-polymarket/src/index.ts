/**
 * @elizaos/plugin-polymarket
 *
 * Polymarket prediction market trading plugin for ElizaOS.
 *
 * Features:
 * - Buy and sell prediction market shares
 * - View markets and search for opportunities
 * - Portfolio tracking and P&L reporting
 * - Risk management with configurable limits
 * - Autonomous trading with LLM-based market analysis
 * - Twitter posting for trade notifications
 *
 * @example
 * ```typescript
 * import { polymarketPlugin } from '@elizaos/plugin-polymarket';
 *
 * const agent = new Agent({
 *   plugins: [polymarketPlugin],
 * });
 * ```
 *
 * @example Running as standalone project
 * ```bash
 * cd packages/plugin-polymarket
 * elizaos start
 * ```
 */

import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import { polymarketPlugin } from './plugin';
import { character } from './character';

// Project agent configuration
const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => {
    logger.info('[PolyTrader] Initializing Polymarket trading agent');
    logger.info({ name: character.name }, '[PolyTrader] Agent name:');
  },
  plugins: [polymarketPlugin],
};

// Project configuration - exported as default for ElizaOS to detect as project
const project: Project = {
  agents: [projectAgent],
};

export default project;
export { polymarketPlugin } from './plugin';
export { PolymarketService } from './services/polymarket';
export { character } from './character';
export * from './types';
export * from './actions';
export * from './providers';
export * from './evaluators';
