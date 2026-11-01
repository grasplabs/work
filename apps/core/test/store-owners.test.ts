import { storeIdSchema, appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { claimStore, storeOwnerOf } from "../src/store-owners.ts";
import { outcome } from "./sign-in.ts";

// A store's one canonical owner (spec 40.8, GRA-682): an App or an
// independent workflow, claimed once and kept for good. The ways it can
// fail, tried here: a store comes to serve a second owner, of either
// kind, or a row names both kinds or none, so an App lookup could find a
// workflow's store.

const newStore = () => storeIdSchema.parse(crypto.randomUUID());
const workflow = () => ({ kind: "workflow" as const, id: crypto.randomUUID() });
const app = () => ({
  kind: "app" as const,
  id: appIdSchema.parse(crypto.randomUUID()),
});

/** Writes an owner row by hand: what the check constraint lets through. */
const insert = async (appId: string | null, workflowId: string | null) =>
  await outcome(
    env.DB.prepare(
      "INSERT INTO sdk_store_owners (store_id, app_id, workflow_id, claimed_at) VALUES (?, ?, ?, 0)"
    )
      .bind(crypto.randomUUID(), appId, workflowId)
      .run()
  );

/** Whether a write ended refused by the check constraint. */
const refused = (end: string): boolean =>
  end.includes("CHECK constraint failed");

describe("a store's owner", () => {
  it("is claimed once, by an App or a workflow, and refused to anyone else of either kind", async () => {
    const theirs = newStore();
    const owner = workflow();
    await claimStore(env, theirs, owner);
    const ours = newStore();
    const owningApp = app();
    await claimStore(env, ours, owningApp);

    expect({
      again: await outcome(claimStore(env, theirs, owner)),
      byApp: await outcome(claimStore(env, theirs, app())),
      byWorkflow: await outcome(claimStore(env, ours, workflow())),
      theirs: await storeOwnerOf(env, theirs),
      ours: await storeOwnerOf(env, ours),
      nobody: await storeOwnerOf(env, newStore()),
    }).toStrictEqual({
      again: "ok",
      byApp: "version.store_bound_elsewhere",
      byWorkflow: "version.store_bound_elsewhere",
      theirs: owner,
      ours: owningApp,
      nobody: undefined,
    });
  });

  it("goes to exactly one of two owners claiming a new store at once", async () => {
    const store = newStore();
    const contenders = [workflow(), app()];
    const outcomes = await Promise.all(
      contenders.map(
        async (owner) => await outcome(claimStore(env, store, owner))
      )
    );
    const winner = contenders[outcomes.indexOf("ok")];

    expect({
      outcomes: outcomes.toSorted(),
      owner: await storeOwnerOf(env, store),
    }).toStrictEqual({
      outcomes: ["ok", "version.store_bound_elsewhere"],
      owner: winner,
    });
  });

  it("names exactly one kind of owner: a row naming both, or neither, is never written", async () => {
    expect({
      both: refused(await insert(crypto.randomUUID(), crypto.randomUUID())),
      neither: refused(await insert(null, null)),
    }).toStrictEqual({ both: true, neither: true });
  });
});
