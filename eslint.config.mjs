import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

import estia from "./packages/lingue/eslint-plugin.mjs";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/core-api/public/**",
      ".data/**",
      ".logs/**",
      "coverage/**",
      // Compilati di Rust (lo spike S6 in infra/spike-app).
      "**/target/**",
      // Generati da `tauri android init` / `tauri ios init`, e la copia di un
      // crate di terzi (apps/app/patches/README.md).
      "apps/app/src-tauri/gen/**",
      "apps/app/patches/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Gli script del laboratorio dei relay girano in Node, fuori dal workspace.
    files: ["infra/relay-lab/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Le regole degli hook non le vede nessun altro controllo: un `useEffect`
    // con una dipendenza mancante passa typecheck, test e build, e sbaglia
    // soltanto a runtime.
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Gli script di build dell'app e il pilota dello spike S7 girano in Node.
    files: [
      "apps/app/scripts/**/*.mjs",
      "apps/ios/scripts/**/*.mjs",
      "apps/android/scripts/**/*.mjs",
      "infra/spike-mls/**/*.mjs",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The web client runs in a browser, not in Node.
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Il testo visibile sta nella tabella delle frasi, non nel codice (ADR 0046,
    // «Come si verifica» 3): una frase scritta qui fa fallire la CI, e la si
    // sposta in packages/lingue. I test restano fuori: affermano quello che
    // l'utente legge, ed è giusto che lo scrivano per esteso.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/**/*.test.{ts,tsx}"],
    plugins: { estia },
    rules: {
      "estia/no-ui-literal": "error",
    },
  },
);
