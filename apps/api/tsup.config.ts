import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/migrate.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  splitting: false,
  dts: false,
});

