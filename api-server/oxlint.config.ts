import { defineConfig } from "oxlint";

import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  ignorePatterns: ["src/generated/**"],
  rules: {
    "eslint/func-style": "off",
    "eslint/no-inline-comments": "off",
    "eslint/no-nested-ternary": "off",
    "eslint/no-use-before-define": "off",
    "unicorn/filename-case": "off",
    "unicorn/no-immediate-mutation": "off",
    "unicorn/no-nested-ternary": "off",
  },
});
