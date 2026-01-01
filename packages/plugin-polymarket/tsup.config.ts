import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false, // Skip DTS due to tsconfig conflicts, types are available in source
  sourcemap: true,
  clean: true,
  external: ['@elizaos/core', 'ethers', '@polymarket/clob-client'],
  treeshake: true,
  skipNodeModulesBundle: true,
});
