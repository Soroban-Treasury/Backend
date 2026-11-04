import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node22",
  external: ["@stellar/stellar-sdk"],
});
