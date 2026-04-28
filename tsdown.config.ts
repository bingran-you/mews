import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: "esm",
    outDir: "dist",
  },
  {
    entry: ["src/mews/engine/statusline.ts"],
    format: "esm",
    outDir: "dist",
    outputOptions: {
      entryFileNames: "mews-statusline.js",
    },
  },
]);
