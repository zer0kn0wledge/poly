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
 * @example Running as standalone project
 * ```bash
 * cd packages/plugin-polymarket
 * elizaos start
 * ```
 *
 * @example Using as a plugin
 * ```typescript
 * import { polymarketPlugin } from '@elizaos/plugin-polymarket/plugin';
 * ```
 */

import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import { polymarketPlugin } from './plugin';
import { character } from './character';

// Project agent configuration
const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => {
    logger.info('[Zeracle] Initializing Polymarket trading agent');
    logger.info({ name: character.name }, '[Zeracle] Agent name:');
  },
  plugins: [polymarketPlugin],
};

// Project configuration - exported as default for ElizaOS to detect as project
const project: Project = {
  agents: [projectAgent],
};

// IMPORTANT: Only export project as default to avoid plugin detection
// The CLI checks if ANY named export has 'name' and 'description' properties
// If found, it treats the module as a plugin instead of a project
export default project;
