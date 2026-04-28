import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: false,
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  splitting: false,
  target: "node20",
});
