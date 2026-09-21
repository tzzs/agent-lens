import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// base './' so the built index.html references assets by relative URL:
// packages/server/static.ts serves apps/web/dist and falls back to index.html
// for non-/api paths, so the SPA must not assume it lives at the host root.
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
