import { defineConfig } from 'astro/config';

// Static mode for MVP — every page prerendered at build time.
// Filing pages: 491+ static HTML files, served from edge with long TTL.
// To swap to hybrid SSR later (e.g. for live homepage on Cloudflare Workers):
//   1. set output: 'server'
//   2. add adapter: cloudflare()  (npm install @astrojs/cloudflare)
//   3. add `export const prerender = true;` to pages we want kept static
export default defineConfig({
  output: 'static',
  site: 'https://tipsheet.markets',
  compressHTML: true,
  build: {
    inlineStylesheets: 'always',              // inline all CSS — no render-blocking external stylesheets
    assets: '_assets',
  },
  vite: {
    ssr: {
      // better-sqlite3 is a native module — keep it external from Vite's SSR bundling
      external: ['better-sqlite3'],
    },
  },
});
