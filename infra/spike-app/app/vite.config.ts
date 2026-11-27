import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// La sonda usa il codice MLS **vero** del client web (apps/web/src/mls), non
// una copia: `ts-mls` si prende da lì, alla versione che il client web fissa.
const web = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
const tsMls = `${web}node_modules/ts-mls/dist/src/`;

// Su un telefono il server di sviluppo va raggiunto dalla rete: la CLI di Tauri
// lo dice con TAURI_DEV_HOST.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^ts-mls$/, replacement: `${tsMls}index.js` },
      { find: /^ts-mls\/(.*)$/, replacement: `${tsMls}$1` },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    fs: { allow: [fileURLToPath(new URL("../../../", import.meta.url))] },
  },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
