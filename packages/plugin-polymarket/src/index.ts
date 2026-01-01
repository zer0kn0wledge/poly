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
 */

export { polymarketPlugin, polymarketPlugin as default } from './plugin';
export { PolymarketService } from './services/polymarket';
export * from './types';
export * from './actions';
export * from './providers';
export * from './evaluators';
