import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { appResourceBindings } from "../src/db/core/schema.ts";
import { revokeResourceBinding } from "../src/resource-bindings.ts";
import { mockIdp } from "./idp.ts";
import {
  active,
  answer,
  approveWriter,
  callOn,
  chooseModel,
  chosenModel,
  draftOn,
  modelFiles,
  outcomeOf,
  providerEnv,
  sealedApp,
} from "./resource-bindings-harness.ts";
import { failure, person } from "./sealed-apps.ts";
import { openRpc, signedInWithRole } from "./sign-in.ts";

// An App's declared resources reach real providers only through bindings
// an admin approved, and the live grant each names, through core's
// operation host (spec 12, 32.3). Each request resolves its binding again,
// so revoking it, changing the declaration or losing the target stops the
// next one; the model gateway is the real one, with only the model
// provider behind connect faked.

describe("model binding spend", { timeout: 120_000 }, () => {
  beforeEach(chooseModel);

  const idp = mockIdp();

  /** The model bindings the models settings list, as `role` reads them. */
  const bindings = async (role: "admin" | "builder") => {
    const { session } = await signedInWithRole(idp, role);
    const { core } = await openRpc(session, { coreEnv: env });
    return await core.authenticate().models.settings();
  };

  it("tell an App its provider's rate limit, with when to try again", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveWriter(sealed);
    const { providerEnv: withProvider } = await providerEnv(
      // Refused for its rate, retries and all, the provider asking for a
      // second and a half.
      Array.from({ length: 3 }, () => ({
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after-ms": "1500" },
      }))
    );
    expect(
      outcomeOf(await callOn(withProvider, sealed, "assist.attempt"))
    ).toBe("resource.rate_limited|2");
  });

  it("list each App's model bindings with this month's spend, each App's apart, to admins only", async () => {
    // Named to sort first, ahead of this file's other Apps.
    const one = await sealedApp(modelFiles(), "0 A One");
    const other = await sealedApp(modelFiles(), "0 B Other");
    const idle = await sealedApp(modelFiles(), "0 C Idle");
    await approveWriter(one);
    await approveWriter(other);
    const idleBinding = await approveWriter(idle);
    const { providerEnv: withProvider } = await providerEnv([
      answer("One."),
      answer("Again."),
      answer("Other."),
    ]);
    await draftOn(withProvider, one);
    await draftOn(withProvider, one);
    await draftOn(withProvider, other);

    const ours = ({ appId }: { appId: string }): boolean =>
      appId === one.app || appId === other.app || appId === idle.app;
    const read = await bindings("admin");
    const listed = read.bindings.listed.filter(ours);
    const [oneSpent, otherSpent, idleSpent] = listed.map(
      ({ thisMonth }) => thisMonth
    );
    expect({
      listed: listed.map(({ appId, appName, alias, model }) => ({
        appId,
        appName,
        alias,
        model,
      })),
      // The same request twice costs twice one; nothing for the idle one.
      twice:
        oneSpent !== undefined && otherSpent !== undefined
          ? Math.abs(oneSpent - 2 * otherSpent) < 1e-9 && otherSpent > 0
          : false,
      idle: idleSpent,
      month: read.month,
    }).toStrictEqual({
      listed: [
        {
          appId: one.app,
          appName: "0 A One",
          alias: "ai",
          model: chosenModel,
        },
        {
          appId: other.app,
          appName: "0 B Other",
          alias: "ai",
          model: chosenModel,
        },
        {
          appId: idle.app,
          appName: "0 C Idle",
          alias: "ai",
          model: chosenModel,
        },
      ],
      twice: true,
      idle: 0,
      month: read.month,
    });

    // A revoked binding isn't listed; one whose target can't be read is,
    // as such, and never hides the others.
    await revokeResourceBinding(env, await person("admin"), idleBinding.id);
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ target: "{not json" })
      .where(active(other.app));
    const later = await bindings("admin");
    expect(
      later.bindings.listed
        .filter(ours)
        .map(({ appId, model }) => ({ appId, model }))
    ).toStrictEqual([
      { appId: one.app, model: chosenModel },
      { appId: other.app, model: null },
    ]);

    await expect(failure(async () => await bindings("builder"))).resolves.toBe(
      "role.forbidden"
    );
  });
});
