import { defineConfig } from "oxlint";

import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  ignorePatterns: ["src/generated/**"],
  rules: {
    // FetchTransport.request implements HttpTransport.request (instance method
    // required by the interface) so `this` is intentionally absent.
    "eslint/class-methods-use-this": "off",
    "eslint/func-style": "off",
    // errors.ts exports 8 LedgerError subclasses in one file — intentional.
    "eslint/max-classes-per-file": "off",
    "eslint/no-inline-comments": "off",
    "eslint/no-nested-ternary": "off",
    "eslint/no-use-before-define": "off",
    "unicorn/filename-case": "off",
    "unicorn/no-immediate-mutation": "off",
    "unicorn/no-nested-ternary": "off",
  },
});
