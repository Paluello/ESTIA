import { defineConfig } from "vitest/config";

// Two projects only because of one thing: the tests of the web client are
// written in Italian, and since ADR 0046 an interface that has not heard from
// its instance speaks English. The setup gives those tests an Italian home,
// the way a real instance installed in Italian would.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["./apps/web/src/prova-in-italiano.ts"],
          // La tabella passa da Vite e non da Node, perché un test possa
          // sostituirne un file (la lingua parziale di ADR 0046 §7).
          server: { deps: { inline: ["@estia/lingue"] } },
        },
      },
      {
        test: {
          name: "istanza",
          include: ["apps/core-api/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
        },
      },
    ],
  },
});
