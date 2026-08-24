import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /*
     * 37 test files boot PGlite — Postgres compiled to WASM — in `beforeAll`.
     *
     * This timeout has been raised twice (5s → 10s → 60s) as that count grew,
     * and each raise bought less than the one before: at 37 files, 60s was
     * reached again under CPU contention and two files failed that pass on
     * their own. Raising it a third time would have been treating the symptom.
     *
     * The fix is in `__testdb__/harness.ts`, which builds the schema ONCE, caches
     * the resulting data directory on disk keyed by a hash of the DDL, and
     * restores every database from it — ~350ms instead of ~1600ms, because the
     * restore skips `initdb`. A repeat run pays nothing at all. The generous
     * timeout stays as margin for a loaded CI box, not as the mechanism.
     *
     * A first run on a cold cache (CI, every time) still pays one build, which
     * is why the margin is worth keeping.
     *
     * A WASM database that boots slowly on a busy machine is not a defect worth
     * a red build, and a suite that fails when CI happens to be loaded is one
     * people learn to re-run rather than read.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
