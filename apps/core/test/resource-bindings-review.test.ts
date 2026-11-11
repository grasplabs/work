import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { revokePermission } from "../src/permissions.ts";
import {
  reviewResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import {
  answer,
  bindDesk,
  call,
  chatScopedCopy,
  chooseModel,
  chosenModel,
  deskApp,
  deskFiles,
  modelFiles,
  nextVersion,
  outcomeOf,
  providerEnv,
  sealedApp,
  statesOf,
} from "./resource-bindings-harness.ts";
import { appWith, failure, person } from "./sealed-apps.ts";

// An App's declared resources reach real providers only through bindings
// an admin approved, and the live grant each names, through core's
// function host (spec 12, 32.3). Each request resolves its binding again,
// so revoking it, changing the declaration or losing the target stops the
// next one; the model gateway is the real one, with only the model
// provider behind connect faked.

describe("an App's resource review", { timeout: 120_000 }, () => {
  beforeEach(chooseModel);

  it("lists what the current version declares, and offers an admin only what may serve it", async () => {
    const { sealed, admin, handbook, permission } = await deskApp();
    // Neither another App's grant nor one held in a chat only is offered.
    await deskApp();
    await chatScopedCopy(permission);
    const review = await reviewResourceBindings(env, admin, sealed.app);
    expect(review).toStrictEqual({
      app: sealed.app,
      version: 1,
      undeclared: [],
      truncated: false,
      resources: [
        {
          alias: "ai",
          kind: "model",
          contract: null,
          actions: [],
          operations: [],
          collections: [],
          maxOutputTokens: 300,
          state: "unbound",
          binding: null,
          choices: {
            kind: "model",
            models: [chosenModel],
            truncated: false,
          },
        },
        {
          alias: "brain",
          kind: "knowledge",
          contract: null,
          actions: [],
          operations: ["search"],
          collections: ["handbook", "salaries"],
          maxOutputTokens: null,
          state: "unbound",
          binding: null,
          // The App's own grant to read, and no other collection.
          choices: {
            kind: "knowledge",
            permissions: [
              {
                permissionId: permission,
                collectionId: handbook.id,
                name: "Handbook",
              },
            ],
            truncated: false,
          },
        },
      ],
    });
  });

  it("offers an admin only the models that can give the longest request", async () => {
    // Mistral Large answers at most 65,536 tokens; GPT-5.4 68,000. A
    // request for text asks for all 65,537 at once.
    const sealed = await sealedApp(modelFiles(65_537));
    const { providerEnv: withProvider } = await providerEnv(
      [],
      [chosenModel, "openai/gpt-5.4"]
    );
    const review = await reviewResourceBindings(
      withProvider,
      await person("admin"),
      sealed.app
    );
    expect(
      review.resources.map(({ alias, choices }) => [alias, choices])
    ).toStrictEqual([
      ["ai", { kind: "model", models: ["openai/gpt-5.4"], truncated: false }],
    ]);
  });

  it("says a permission is served exactly when its next request is", async () => {
    const desk = await deskApp();
    const unbound = await call(env, desk.sealed, "desk.find", {
      text: "leave",
    });
    await bindDesk(desk);
    const review = await reviewResourceBindings(
      env,
      desk.admin,
      desk.sealed.app
    );
    const bound = await call(env, desk.sealed, "desk.find", { text: "leave" });
    const brain = review.resources.find(({ alias }) => alias === "brain");
    // Revoked: unbound again, and the next request is refused.
    await revokeResourceBinding(env, desk.admin, brain?.binding?.id);
    const revoked = await reviewResourceBindings(
      env,
      desk.admin,
      desk.sealed.app
    );
    const afterRevoke = await call(env, desk.sealed, "desk.find", {
      text: "leave",
    });
    expect({
      unbound: outcomeOf(unbound),
      states: statesOf(review),
      bound: outcomeOf(bound),
      revoked: statesOf(revoked),
      afterRevoke: outcomeOf(afterRevoke),
    }).toStrictEqual({
      unbound: { failed: "permission.unavailable" },
      states: { ai: "served", brain: "served" },
      bound: [],
      revoked: { ai: "served", brain: "unbound" },
      afterRevoke: { failed: "permission.unavailable" },
    });
  });

  it("says why a binding no longer serves: a lost grant, or a changed declaration", async () => {
    const desk = await deskApp();
    const { sealed, admin, permission } = desk;
    await bindDesk(desk);
    // The collection grant is revoked, and the organization chooses
    // another model: both targets are lost.
    await revokePermission(env, admin, permission);
    const { providerEnv: narrowed } = await providerEnv([], ["openai/gpt-5.4"]);
    const lost = await reviewResourceBindings(narrowed, admin, sealed.app);
    const found = await call(env, sealed, "desk.find", { text: "leave" });
    // A version that reads one collection less, and no AI at all.
    const next = await nextVersion(
      sealed,
      deskFiles({ withWriter: false, collections: ["handbook"] }),
      2
    );
    const changed = await reviewResourceBindings(env, admin, sealed.app);
    const read = await call(env, next, "desk.find", { text: "leave" });
    expect({
      lost: statesOf(lost),
      found: outcomeOf(found),
      changed: statesOf(changed),
      undeclared: changed.undeclared.map(({ alias }) => alias),
      read: outcomeOf(read),
    }).toStrictEqual({
      lost: { ai: "grant_lost", brain: "grant_lost" },
      found: { failed: "permission.unavailable" },
      changed: { brain: "declaration_changed" },
      undeclared: ["ai"],
      read: { failed: "permission.unavailable" },
    });
  });

  it("lists every binding a version can reach, and refuses a request through any it doesn't list as served", async () => {
    // The attack: a binding an admin approved for one version reaches a
    // later one the review shows otherwise. Version 2 widens `ai`; version
    // 3 declares it as approved again and drops `brain`, whose binding
    // stays active, keeping code that reaches for it.
    const desk = await deskApp();
    const { sealed, admin } = desk;
    await bindDesk(desk);
    const next = await nextVersion(
      sealed,
      deskFiles({ withWriter: true, maxOutputTokens: 400, sneak: true }),
      2
    );
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Never sent."),
    ]);
    // Its `ai` widened past what was approved: a request reaches nothing.
    const widened = await call(withProvider, next, "desk.draft", {
      prompt: "Hi",
    });
    const dropped = await nextVersion(
      next,
      deskFiles({ withBrain: false, sneak: true }),
      3
    );
    const review = await reviewResourceBindings(env, admin, sealed.app);
    const brainBinding = review.undeclared.find(
      ({ alias }) => alias === "brain"
    );
    expect({
      // Version 3: its own declarations, each with how it is bound, and
      // every other active binding listed as serving nothing.
      declared: review.resources.map(({ alias, state }) => [alias, state]),
      undeclared: review.undeclared.map(({ alias }) => alias),
      brainStillActive: brainBinding?.status,
      widened: outcomeOf(widened),
      sent: provider.requests.length,
      // Code that reaches for a permission its version doesn't list has
      // nothing to reach it with, though the binding is still active.
      sneak: outcomeOf(await call(env, dropped, "desk.sneak", {})),
      // Nor does a call through the last version's reference to the
      // function that read through it reach the binding.
      find: outcomeOf(await call(env, next, "desk.find", { text: "leave" })),
    }).toStrictEqual({
      declared: [["ai", "served"]],
      undeclared: ["brain"],
      brainStillActive: "active",
      widened: { failed: "permission.unavailable" },
      sent: 0,
      sneak: "absent",
      find: { failed: "function.not_found" },
    });
  });

  it("shows the App's builders its bindings with nothing to choose, and nobody else", async () => {
    const desk = await deskApp();
    await bindDesk(desk);
    const builders = await reviewResourceBindings(
      env,
      desk.sealed.owner,
      desk.sealed.app
    );
    // Grasp staff build as admins do, but never decide a binding.
    const staff = await reviewResourceBindings(
      env,
      { ...(await person("admin")), staff: true },
      desk.sealed.app
    );
    const member = await person("user");
    // A builder, of an App of their own, but not of this one.
    const { owner: otherBuilder } = await appWith(deskFiles());
    expect({
      states: statesOf(builders),
      choices: builders.resources.map(({ choices }) => choices),
      // The bound target named, for builders too: only the collection bound.
      labels: builders.resources.map(({ binding }) => binding?.label),
      staff: staff.resources.map(({ choices }) => choices),
      member: await failure(
        async () => await reviewResourceBindings(env, member, desk.sealed.app)
      ),
      otherBuilder: await failure(
        async () =>
          await reviewResourceBindings(env, otherBuilder, desk.sealed.app)
      ),
    }).toStrictEqual({
      states: { ai: "served", brain: "served" },
      choices: [null, null],
      labels: [
        { connection: null, collections: {} },
        {
          connection: null,
          collections: { handbook: "Handbook", salaries: "Handbook" },
        },
      ],
      staff: [null, null],
      member: "app.not_found",
      otherBuilder: "app.not_found",
    });
  });
});
