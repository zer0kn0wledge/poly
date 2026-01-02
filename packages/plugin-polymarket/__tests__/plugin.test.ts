/**
 * Polymarket Plugin Tests
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { polymarketPlugin } from '../src/plugin';
import type { IAgentRuntime } from '@elizaos/core';

describe('Polymarket Plugin', () => {
  describe('Plugin Configuration', () => {
    it('should have correct plugin name', () => {
      expect(polymarketPlugin.name).toBe('plugin-polymarket');
    });

    it('should have a description', () => {
      expect(polymarketPlugin.description).toBeDefined();
      expect(polymarketPlugin.description).toContain('Polymarket');
    });

    it('should export required components', () => {
      expect(polymarketPlugin.services).toBeDefined();
      expect(polymarketPlugin.services?.length).toBeGreaterThan(0);

      expect(polymarketPlugin.actions).toBeDefined();
      expect(polymarketPlugin.actions?.length).toBeGreaterThan(0);

      expect(polymarketPlugin.providers).toBeDefined();
      expect(polymarketPlugin.providers?.length).toBeGreaterThan(0);
    });

    it('should have expected actions', () => {
      const actionNames = polymarketPlugin.actions?.map(a => a.name) || [];
      expect(actionNames).toContain('BUY_PREDICTION');
      expect(actionNames).toContain('SELL_PREDICTION');
      expect(actionNames).toContain('VIEW_MARKETS');
      expect(actionNames).toContain('VIEW_POSITIONS');
      expect(actionNames).toContain('MARKET_DETAILS');
    });

    it('should have expected providers', () => {
      const providerNames = polymarketPlugin.providers?.map(p => p.name) || [];
      expect(providerNames).toContain('POLYMARKET_PORTFOLIO');
      expect(providerNames).toContain('POLYMARKET_MARKETS');
    });
  });

  describe('Plugin Initialization', () => {
    it('should initialize without private key (read-only mode)', async () => {
      const config = {};
      await expect(polymarketPlugin.init?.(config)).resolves.toBeUndefined();
    });

    it('should initialize with valid config', async () => {
      const config = {
        POLYMARKET_MAX_POSITION_SIZE: '100',
        POLYMARKET_MAX_PORTFOLIO_RISK: '1000',
      };
      await expect(polymarketPlugin.init?.(config)).resolves.toBeUndefined();
    });
  });

  describe('Routes', () => {
    it('should have status route', () => {
      const routes = polymarketPlugin.routes || [];
      const statusRoute = routes.find(r => r.path === '/polymarket/status');
      expect(statusRoute).toBeDefined();
      expect(statusRoute?.type).toBe('GET');
    });

    it('should have markets route', () => {
      const routes = polymarketPlugin.routes || [];
      const marketsRoute = routes.find(r => r.path === '/polymarket/markets');
      expect(marketsRoute).toBeDefined();
      expect(marketsRoute?.public).toBe(true);
    });
  });
});

describe('Buy Action Validation', () => {
  const buyAction = polymarketPlugin.actions?.find(a => a.name === 'BUY_PREDICTION');

  it('should validate buy intent messages', async () => {
    const mockRuntime = {} as IAgentRuntime;
    const mockMessage = {
      content: { text: 'Buy $50 on Yes for Bitcoin ETF' },
    } as any;

    const isValid = await buyAction?.validate?.(mockRuntime, mockMessage, undefined);
    expect(isValid).toBe(true);
  });

  it('should validate bet intent messages', async () => {
    const mockRuntime = {} as IAgentRuntime;
    const mockMessage = {
      content: { text: 'I want to bet $100 on the election market' },
    } as any;

    const isValid = await buyAction?.validate?.(mockRuntime, mockMessage, undefined);
    expect(isValid).toBe(true);
  });

  it('should not validate unrelated messages', async () => {
    const mockRuntime = {} as IAgentRuntime;
    const mockMessage = {
      content: { text: 'What is the weather today?' },
    } as any;

    const isValid = await buyAction?.validate?.(mockRuntime, mockMessage, undefined);
    expect(isValid).toBe(false);
  });
});

describe('View Markets Action Validation', () => {
  const viewAction = polymarketPlugin.actions?.find(a => a.name === 'VIEW_MARKETS');

  it('should validate market search messages', async () => {
    const mockRuntime = {} as IAgentRuntime;
    const mockMessage = {
      content: { text: 'Show me prediction markets about crypto' },
    } as any;

    const isValid = await viewAction?.validate?.(mockRuntime, mockMessage, undefined);
    expect(isValid).toBe(true);
  });

  it('should validate list markets messages', async () => {
    const mockRuntime = {} as IAgentRuntime;
    const mockMessage = {
      content: { text: 'List available betting markets' },
    } as any;

    const isValid = await viewAction?.validate?.(mockRuntime, mockMessage, undefined);
    expect(isValid).toBe(true);
  });
});
