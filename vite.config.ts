import { defineConfig } from 'vite';

// start.ng hosts the built game from a subdomain and requires relative asset
// paths (`./assets/...`, never `/assets/...`), and it never runs `npm run build`.
export default defineConfig({
  base: './',
});
