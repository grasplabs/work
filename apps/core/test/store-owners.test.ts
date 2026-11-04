import { storeIdSchema, appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { claimStore, storeOwnerOf } from "../src/store-owners.ts";
import { outcome } from "./sign-in.ts";

// A store's one canonical owner (spec 40.8): the App that claimed it,
// once and for good. The way it can fail, tried here: a store comes to
// serve a second App.

const newStore = () => storeIdSchema.parse(crypto.randomUUID());
const app = () => appIdSchema.parse(crypto.randomUUID());

describe("a store's owner", () => {
  it("is claimed once, by an App, and refused to any other", async () => {
    const store = newStore();
    const owner = app();
    await claimStore(env, store, owner);

    expect({
      again: await outcome(claimStore(env, store, owner)),
      byAnother: await outcome(claimStore(env, store, app())),
      owner: await storeOwnerOf(env, store),
      nobody: await storeOwnerOf(env, newStore()),
    }).toStrictEqual({
      again: "ok",
      byAnother: "version.store_bound_elsewhere",
      owner,
      nobody: undefined,
    });
  });

  it("goes to exactly one of two Apps claiming a new store at once", async () => {
    const store = newStore();
    const contenders = [app(), app()];
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
});
