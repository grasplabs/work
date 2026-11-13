import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appPublishing } from "../../src/app-publish.ts";
import { sealRelease } from "../../src/app-releases.ts";
import { findApp } from "../../src/apps.ts";
import { platformPlaceWaitMs } from "../../src/platform-sandbox.ts";
import { rollback } from "../../src/publish.ts";
import { sandboxSubOwnerHeader } from "../../src/sandbox-headers.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import {
  appWith,
  envWith,
  heldPlace,
  suiteOf,
  supervisor,
} from "./app-test-harness.ts";

// An App's tests on-prem, as in app-tests.test.ts: here a suite waiting
// for its place in the sandbox supervisor, and the session a suite's code
// runs in. Apart from app-tests.test.ts so the two can run on different
// runners.

describe("an App's tests on-prem", { timeout: 180_000 }, () => {
  it("ask again for the builder's place while the App's builds hold it past one build's wait", async () => {
    // Files no build was made of yet, sealed before the builder is held.
    const built = await appWith(
      suiteOf(`expect(1).toBe(1); // ${crypto.randomUUID()}`)
    );
    await sealRelease(env, { app: built.app, version: 1, by: built.owner });
    // The App's builds hold its part of the builder's share. It frees
    // only once the test build asked again after one build's own asks
    // for a place were over: asked again by activation, not by the build.
    const giveUp = new AbortController();
    const { ended: held } = await heldPlace(
      "platform:builder",
      giveUp.signal,
      built.app
    );
    let firstAsk: number | undefined;
    const askedAgain = Promise.withResolvers<null>();
    const watching: Fetcher = {
      ...supervisor(),
      fetch: async (input, init) => {
        const headers: unknown = init?.headers;
        const of: unknown =
          typeof headers === "object" && headers !== null
            ? Reflect.get(headers, sandboxSubOwnerHeader)
            : undefined;
        if (of === built.app) {
          firstAsk ??= Date.now();
          if (Date.now() - firstAsk > platformPlaceWaitMs) {
            askedAgain.resolve(null);
          }
        }
        return await supervisor().fetch(input, init);
      },
    };
    const activating = (async (): Promise<unknown> => {
      try {
        await rollback(
          envWith({ SANDBOX_HOST: watching }),
          appPublishing,
          built.owner,
          built.app,
          1
        );
        const found = await findApp(env, built.app);
        return found?.currentVersion;
      } catch (error) {
        return error instanceof SandboxUnavailableError
          ? "unavailable"
          : String(error);
      }
    })();
    // Never asked again: freed anyway, the activation having given up.
    await Promise.race([
      askedAgain.promise,
      activating,
      scheduler.wait(60_000),
    ]);
    giveUp.abort();
    await expect(held).resolves.toBe("given up");
    await expect(activating).resolves.toBe(1);
  });
});
