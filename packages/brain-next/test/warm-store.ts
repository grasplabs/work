/**
 * A setup file for the store's tests: before each file's first test, one
 * call into the store every file shares (`BRAIN_STORE`, "brain"), so the
 * store's start-up is paid in this hook, not in whichever test first
 * calls it. That start-up is the file's runtime loading the store's
 * modules through Vite's module fallback, and the store's constructor
 * running its migrations (store.ts, `blockConcurrencyWhile`): 1.3 to 1.6 s
 * locally, against 1 to 2 ms for the next call. On a loaded CI runner it
 * passed a test's 5 s, and twice cut `restatements.test.ts`'s first test
 * at it, its retry too (the first attempt still held the start-up), while
 * the shard imported a long file beside it (November 2026). The hook has a
 * time of its own for that start-up alone; every test keeps the default.
 */
import { env } from "cloudflare:workers";
import { beforeAll } from "vite-plus/test";

/** How long the store's start-up may take: a loaded runner's, with room. */
const startUpMs = 60_000;

beforeAll(async () => {
  await env.BRAIN_STORE.getByName("brain").workOverview();
}, startUpMs);
