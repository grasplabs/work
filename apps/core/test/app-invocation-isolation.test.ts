import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { setCurrentVersion } from "../src/apps.ts";
import { appMembers } from "../src/db/core/schema.ts";
import { release as released } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { isolationFiles } from "./isolation-app.ts";
import { chatWithDraft, outcome, requestFor } from "./previews.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// What App code keeps of one invocation never acts in another (GRA-383,
// GRA-387), through the real Loader: every invocation runs in a fresh
// isolate of its own, and its channel stops working when it ends, on a
// screen's calls and, below, on a chat's preview of its draft
// (sealed-previews.ts), across two people's chats. The
// held-call reproduction from GRA-383, the channel kept past its call,
// and state one caller leaves for the next. A call cut short at its
// deadline is app-functions.test.ts's ("a call past its deadline").
//
// Work App code schedules for after its call never runs: the isolate is
// discarded once the call answers, so a late write through a kept channel
// can't even be attempted, and its refusal can't be observed from here.
// That a channel refuses every use once its invocation ended
// (`operation.ended`) is operations.test.ts's, where the host's channel
// is reached directly.

type Sealed = Fixture & { release: Release };
type Caller = Fixture["owner"];

/** The App, sealed and current, used by its builder and by `others`. */
const sealedApp = async (): Promise<Sealed & { other: Caller }> => {
  const fixture = await appWith(isolationFiles);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  const other = await person("user");
  await drizzle(env.DB).insert(appMembers).values({
    appId: fixture.app,
    memberType: "person",
    memberId: other.userId,
    role: "user",
    addedBy: fixture.owner.userId,
    addedAt: new Date(),
  });
  return { ...fixture, release, other };
};

/** Calls `path` of the App for `by`, as a screen sends it. */
const call = async (
  { app, release }: Sealed,
  by: Caller,
  path: string,
  input: Json = {}
): Promise<OperationResult> => {
  const operation = release.app.operations[path];
  const { result } = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path],
        kind: operation?.kind,
      },
      input,
    })
  );
  return result;
};

describe("an invocation's authority", { timeout: 120_000 }, () => {
  it("never reaches another caller's call held open alongside it", async () => {
    const isolated = await sealedApp();
    const held = call(isolated, isolated.owner, "notes.hold");
    // A has kept its channel and is still running once its note shows.
    await vi.waitFor(
      async () => {
        await expect(
          call(isolated, isolated.owner, "notes.titles")
        ).resolves.toStrictEqual({ ok: true, value: ["A holding"] });
      },
      { timeout: 10_000, interval: 100 }
    );
    // B calls while A holds, its channel kept in module state.
    const used = await call(isolated, isolated.other, "notes.useKept");
    expect(used).toStrictEqual({ ok: true, value: "nothing kept" });
    // Only now is A let go.
    await call(isolated, isolated.owner, "notes.create", { title: "release" });
    await expect(held).resolves.toStrictEqual({ ok: true, value: null });
    await expect(
      call(isolated, isolated.owner, "notes.titles")
    ).resolves.toStrictEqual({
      ok: true,
      value: ["A holding", "release"],
    });
  });

  it("ends with its call: work scheduled past it never runs, and writes nothing", async () => {
    const isolated = await sealedApp();
    await expect(
      call(isolated, isolated.owner, "notes.keepAfter")
    ).resolves.toStrictEqual({
      ok: true,
      value: null,
    });
    await scheduler.wait(1000);
    await expect(
      call(isolated, isolated.owner, "notes.titles")
    ).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });

  it("leaves nothing of one caller's in the cached release for the next", async () => {
    const isolated = await sealedApp();
    await expect(
      call(isolated, isolated.owner, "notes.poison")
    ).resolves.toStrictEqual({
      ok: true,
      value: null,
    });
    // The same release, from the verified cache, for another person and
    // for the same one again.
    for (const by of [isolated.other, isolated.owner]) {
      // oxlint-disable-next-line no-await-in-loop -- one caller after the other
      await expect(call(isolated, by, "notes.probe")).resolves.toStrictEqual({
        ok: true,
        value: ["clean", "clean", "clean"],
      });
    }
  });
});

const idp = mockIdp();

describe(
  "an invocation's authority in a draft's preview",
  { timeout: 180_000 },
  () => {
    it("never reaches another person's preview, held open alongside it, nor outlives its call, nor leaves anything for the next", async () => {
      const owner = await signedInApi(idp, "builder");
      const { id } = await owner.api.apps.create({ name: "Isolation" });
      const app = appIdSchema.parse(id);
      await released(owner, app, isolationFiles);
      const other = await signedInApi(idp, "builder");
      await owner.api.apps.members.add(app, {
        type: "person",
        id: other.userId,
        role: "builder",
      });
      const drafted = {
        "operations/notes.ts": `${isolationFiles["operations/notes.ts"] ?? ""}\n// Drafted.\n`,
      };
      const [ownDraft, theirDraft] = await Promise.all([
        chatWithDraft(owner, app, drafted),
        chatWithDraft(other, app, drafted),
      ]);
      type Drafter = typeof owner;
      const previewed = async (
        by: Drafter,
        { chatId, revision }: typeof ownDraft,
        path: string,
        input: Json = {}
      ): Promise<unknown> =>
        outcome(
          await by.api.chats.previewFunction(
            chatId,
            app,
            revision,
            await requestFor(by, { chatId, app, revision }, path, input)
          )
        );

      const held = previewed(owner, ownDraft, "notes.hold");
      await vi.waitFor(
        async () => {
          await expect(
            previewed(owner, ownDraft, "notes.titles")
          ).resolves.toStrictEqual(["A holding"]);
        },
        { timeout: 10_000, interval: 100 }
      );
      // The other person's preview calls while A holds, A's channel kept in
      // module state.
      const used = await previewed(other, theirDraft, "notes.useKept");
      const theirs = await previewed(other, theirDraft, "notes.titles");
      await previewed(owner, ownDraft, "notes.create", { title: "release" });
      const unheld = await held;
      const kept = await previewed(other, theirDraft, "notes.keepAfter");
      await scheduler.wait(1000);
      const after = await previewed(other, theirDraft, "notes.titles");
      await previewed(owner, ownDraft, "notes.poison");
      const probed = [
        await previewed(other, theirDraft, "notes.probe"),
        await previewed(owner, ownDraft, "notes.probe"),
      ];

      expect({
        used,
        theirs,
        released: unheld,
        kept,
        after,
        probed,
      }).toStrictEqual({
        used: "nothing kept",
        theirs: [],
        released: null,
        kept: null,
        after: [],
        probed: [
          ["clean", "clean", "clean"],
          ["clean", "clean", "clean"],
        ],
      });
    });
  }
);
