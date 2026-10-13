import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts"],
    environment: "node",
    /** Integration tests stand up a real server and real sockets. */
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
