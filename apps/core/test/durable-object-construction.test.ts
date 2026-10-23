/**
 * The test runtime keeps constructing Durable Objects for as long as a
 * shard runs, files sharing it (`isolate: false`): thousands of one class
 * must not break it. vitest-pool-workers wrapped a class's prototype in
 * one more Proxy on every construction, until a property lookup
 * overflowed the stack and every object of the class, in every file
 * after, failed to construct (GRA-972); the patch in patches/ wraps it
 * once.
 */
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";

/** More objects of one class than the runtime held before the patch. */
const constructed = 2500;

/** How many App hosts are woken at once. */
const atOnce = 50;

describe("the test runtime", { timeout: 120_000 }, () => {
  it("constructs thousands of objects of one class and still answers", async () => {
    const ids = Array.from({ length: constructed }, () =>
      appIdSchema.parse(crypto.randomUUID())
    );
    for (let at = 0; at < ids.length; at += atOnce) {
      // oxlint-disable-next-line no-await-in-loop -- a few hosts at a time
      await Promise.all(
        ids
          .slice(at, at + atOnce)
          .map(async (id) => await appHost(env, id).accessRevoked(null))
      );
    }

    await expect(
      appHost(env, appIdSchema.parse(crypto.randomUUID())).accessRevoked(null)
    ).resolves.toBe(0);
  });
});
