import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = process.env.ESTIA_API_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig(({ mode }) => ({
  build: {
    // Written straight where core-api serves it from (ADR 0010). La build per
    // l'app (`--mode app`, ADR 0044) va invece dove Tauri la impacchetta.
    emptyOutDir: true,
    outDir: mode === "app" ? "../app/dist" : "../core-api/public",
    sourcemap: mode !== "app",
  },
  define: {
    __ESTIA_APP__: JSON.stringify(mode === "app"),
    // Solo in `vite` (dev): se il proxy punta a un NAS, gli inviti usano
    // quell'origine anche quando la UI è su 127.0.0.1. In build resta vuoto —
    // l'istanza e la SPA condividono già l'origine (ADR 0010).
    __ESTIA_INSTANCE_ORIGIN__: JSON.stringify(
      mode === "development" ? new URL(API_TARGET).origin : "",
    ),
  },
  plugins: [react()],
  server:
    mode === "app"
      ? {
          // Nell'app l'API non passa da qui ma dal filo nativo. Su un telefono
          // il server di sviluppo si raggiunge dalla rete: la CLI di Tauri dice
          // dove con TAURI_DEV_HOST.
          host: process.env.TAURI_DEV_HOST ?? false,
          ...(process.env.TAURI_DEV_HOST === undefined
            ? {}
            : { hmr: { host: process.env.TAURI_DEV_HOST, port: 5174, protocol: "ws" as const } }),
        }
      : {
          // In development the client runs on its own port and forwards the API to
          // the instance, so the same relative URLs work in both settings.
          host: true,
          proxy: {
            "/api": { changeOrigin: true, target: API_TARGET },
          },
        },
}));
