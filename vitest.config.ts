   import { defineConfig } from "vitest/config";
   export default defineConfig({
     test: { fileParallelism: false, environment: "node", include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"], testTimeout: 15000 },
   });