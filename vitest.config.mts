import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Lets tests resolve the "@/..." imports the app code uses (the same alias as tsconfig.json).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]$/, "") },
  },
});
