import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { readVerified, throughCache } from "../src/build-cache.ts";

// The build cache's lease, called as screens.ts calls it, with core's D1
// and R2: a holder that outlived its lease and finished late never
// replaces what the build that took the lease over kept (build-cache.ts).

describe("the build cache's lease", { timeout: 30_000 }, () => {
  it("keeps nothing of a holder that lost its lease over the build that took it over", async () => {
    const key = `screen-builds/test/${crypto.randomUUID()}.json`;
    const late = Promise.withResolvers<boolean>();
    // A lease shorter than this build: it runs out while it builds.
    const slow = throughCache(
      env,
      key,
      200,
      async () => {
        await late.promise;
        return { text: '{"ok":true,"by":"slow"}', cache: true };
      },
      () => ({})
    );
    await scheduler.wait(400);
    // Its lease ran out: this one takes it over, and keeps its build.
    const fast = await throughCache(
      env,
      key,
      10_000,
      async () =>
        await Promise.resolve({ text: '{"ok":true,"by":"fast"}', cache: true }),
      () => ({})
    );
    late.resolve(true);
    const slowAnswered = await slow;
    const kept = await readVerified(env, key);

    expect({
      fast: fast.text,
      // The slow one still answers its own build, and keeps none of it.
      slow: slowAnswered.text,
      kept: kept.state === "hit" ? kept.text : kept.state,
    }).toStrictEqual({
      fast: '{"ok":true,"by":"fast"}',
      slow: '{"ok":true,"by":"slow"}',
      kept: '{"ok":true,"by":"fast"}',
    });
  });
});
