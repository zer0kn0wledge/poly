/**
 * @elizaos/plugin-polymarket
 *
 * Polymarket prediction market trading plugin for ElizaOS.
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
