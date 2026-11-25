import { devResetPath } from "@grasp-os/shared/dev-reset";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/index.ts";
import { Onboarding, onboardingStore } from "../src/onboarding/store.ts";
import { routed } from "./sign-in.ts";

// The onboarding started over on a local stack (src/onboarding/dev-reset.ts),
// so whoever works on it walks the setup again without stopping the stack.
// The ways it can fail, tried here:
//
// - A deployed core answering it: anyone could wipe a client's onboarding.
// - Someone not signed in starting it over.
// - The object wiping itself where it is not on a local stack.
// - What was kept surviving it, or the object left without its tables.

const by = { type: "person", userId: "user-1" } as const;

/** A request to start over, to a core with `coreEnv`. */
const startOver = async (coreEnv: Env): Promise<Response> =>
  await worker.fetch(
    new Request(`http://localhost:8787${devResetPath}`, { method: "POST" }),
    coreEnv,
    createExecutionContext()
  );

describe("starting the onboarding over", () => {
  it("is no route on a deployed core", async () => {
    // Past the router, as every request to a deployed core comes.
    const answer = await routed(devResetPath, { method: "POST" });
    expect(answer.status).toBe(404);
  });

  it("asks who is there on a local stack", async () => {
    const local = { ...env, DEV_SKIP_ROUTER_SECRET: "true" };
    const answer = await startOver(local);
    expect(answer.status).toBe(401);
  });

  it("is refused by the object anywhere but a local stack", async () => {
    const stub = onboardingStore(env);
    await runInDurableObject(stub, (store: Onboarding) => {
      store.finishSteps(["welcome"], by);
    });
    await expect(stub.startOverLocally()).resolves.toBeFalsy();
    const place = await stub.place();
    expect(place.done).toStrictEqual(["welcome"]);
  });

  it("forgets every screen finished on a local stack, and is ready at once", async () => {
    const stub = onboardingStore(env);
    await runInDurableObject(stub, async (_store, state) => {
      const local = new Onboarding(state, {
        ...env,
        DEV_SKIP_ROUTER_SECRET: "true",
      });
      local.finishSteps(["welcome", "ai"], by);
      await expect(local.startOverLocally()).resolves.toBeTruthy();
      expect(local.place()).toStrictEqual({ done: [] });
      expect(local.finishSteps(["welcome"], by).done).toStrictEqual([
        "welcome",
      ]);
    });
  });
});
