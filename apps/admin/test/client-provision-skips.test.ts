import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { clientProvisions, clients } from "../src/db/schema.ts";
import {
  runClientProvision,
  startClientRelease,
} from "../src/hosting/operation.ts";
import {
  attempt,
  cloudflare,
  codeFrom,
  context,
  failing,
  importRelease,
  isUpload,
  liveClient,
  migrationsRun,
  operationOf,
  runs,
  scriptsOf,
  setUp,
  token,
} from "./client-provision-harness.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { clientScripts } from "./grasp-account.ts";
import { db, staff } from "./hosting.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: which Workers a run uploads again, and which it leaves be because
// the script runs that very upload already; and uploads Cloudflare refuses
// as replays of one it applied. The rest in the other
// client-provision-*.test.ts files.

mockCloudflareApi(token, cloudflare);

/** How many uploads `script` has had in `account`. */
const uploadsOf = (account: AccountState, script: string): number =>
  account.scriptUploads.filter((upload) => upload.script === script).length;

/** The entry module `script` runs in `account`, as its last version has it. */
const codeOn = (account: AccountState, script: string): unknown =>
  clientScripts(account).get(script)?.versions.at(-1)?.modules[0]?.content;

/** The status of client `clientId`'s operation. */
const statusOf = async (clientId: string): Promise<string | undefined> => {
  const operation = await operationOf(clientId);
  return operation?.status;
};

/** Runs client `clientId`'s settings again, as Apply settings now does. */
const runAgain = async (clientId: string): Promise<void> => {
  await startClientRelease(db, staff, await attempt(clientId), {
    again: true,
  });
  await runClientProvision(context, await attempt(clientId));
};

/**
 * Releases client `clientId` to a new release whose core alone changed,
 * its code `core`, and runs it.
 */
const releaseCore = async (clientId: string, core: string): Promise<void> => {
  const next = await importRelease({ notes: "feat(core): next", core });
  await startClientRelease(db, staff, await attempt(clientId), {
    releaseId: next.releaseId,
  });
  await runClientProvision(context, await attempt(clientId));
};

/** Lets every call an earlier run marked count as landed (`sendSettleMs`). */
const ageOutMarks = async (clientId: string): Promise<void> => {
  await db
    .update(clientProvisions)
    .set({
      sending: sql`(SELECT json_group_object(key, json_set(value, '$.at', 0)) FROM json_each(${clientProvisions.sending}))`,
    })
    .where(eq(clientProvisions.clientId, clientId));
};

describe("which Workers a run uploads", () => {
  useStoreSecrets({ deployer: token });

  it("uploads both on a first deploy; a later release, and the rollback from it, upload only the Worker whose upload changed", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { core, connect } = await scriptsOf(clientId);
    const firstUploads = {
      core: uploadsOf(account, core),
      connect: uploadsOf(account, connect),
    };
    // Core's code changed; connect's didn't.
    const later = await importRelease({
      notes: "feat(core): later",
      core: "export default { core: 2 };",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));
    const onLater = {
      core: uploadsOf(account, core),
      connect: uploadsOf(account, connect),
      runs: await runs(clientId),
    };
    await startClientRelease(db, staff, await attempt(clientId), {
      rollback: true,
    });
    await runClientProvision(context, await attempt(clientId));

    expect({
      firstUploads,
      onLater,
      rolledBack: {
        core: uploadsOf(account, core),
        connect: uploadsOf(account, connect),
        code: codeOn(account, core),
        status: await statusOf(clientId),
      },
    }).toStrictEqual({
      firstUploads: { core: 1, connect: 1 },
      // Connect's Durable Objects run on: its upload is the same.
      onLater: {
        core: 2,
        connect: 1,
        runs: { core: later.releaseId, connect: later.releaseId },
      },
      rolledBack: {
        core: 3,
        connect: 1,
        code: "export default { core: 1 };",
        status: "done",
      },
    });
  });

  it("uploads a Worker again on a rollback to a release whose Worker differs", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { connect } = await scriptsOf(clientId);
    const later = await importRelease({
      notes: "feat(connect): later",
      connect: "export default { later: true };",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));
    const onLater = codeOn(account, connect);
    await startClientRelease(db, staff, await attempt(clientId), {
      rollback: true,
    });
    await runClientProvision(context, await attempt(clientId));

    expect({
      onLater,
      rolledBack: codeOn(account, connect),
      uploads: uploadsOf(account, connect),
    }).toStrictEqual({
      onLater: "export default { later: true };",
      rolledBack: "export default {};",
      uploads: 3,
    });
  });

  it("uploads a Worker again on a release when its secrets changed: a rotation", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { connect } = await scriptsOf(clientId);
    const secretsOf = () =>
      clientScripts(account).get(connect)?.versions.at(-1)?.secrets;
    const before = new Map(secretsOf());
    await db
      .update(clients)
      .set({ generation: 2, rotatedAt: new Date() })
      .where(eq(clients.id, clientId));
    // A release whose connect sends the same code: its secrets differ.
    await releaseCore(clientId, "export default { core: 2 };");
    const after = secretsOf() ?? new Map<string, string>();

    expect({
      uploads: uploadsOf(account, connect),
      changed: [...after].some(([name, value]) => before.get(name) !== value),
    }).toStrictEqual({ uploads: 2, changed: true });
  });

  it("uploads a Worker whole on a release once it was deleted, or its bindings changed, beside the admin", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { connect } = await scriptsOf(clientId);
    const scripts = clientScripts(account);

    await releaseCore(clientId, "export default { core: 2 };");
    const unchanged = uploadsOf(account, connect);

    // Deleted out of band.
    scripts.delete(connect);
    await releaseCore(clientId, "export default { core: 3 };");
    const afterDeletion = {
      uploads: uploadsOf(account, connect),
      exists: scripts.has(connect),
    };

    // A binding changed out of band, as a change Cloudflare doesn't date:
    // the script reads as modified when it was, with another binding.
    const live = scripts.get(connect)?.versions.at(-1);
    if (live === undefined) {
      throw new Error("connect isn't in the fake");
    }
    const bindings = z
      .array(z.object({ type: z.string(), name: z.string() }).loose())
      .parse(live.metadata.bindings);
    live.metadata = {
      ...live.metadata,
      bindings: [...bindings, { type: "json", name: "STRAY", json: true }],
    };
    await releaseCore(clientId, "export default { core: 4 };");
    const repaired = z
      .array(z.object({ name: z.string() }).loose())
      .parse(scripts.get(connect)?.versions.at(-1)?.metadata.bindings)
      .some(({ name }) => name === "STRAY");

    expect({
      unchanged,
      afterDeletion,
      afterBindings: uploadsOf(account, connect),
      stray: repaired,
    }).toStrictEqual({
      unchanged: 1,
      afterDeletion: { uploads: 2, exists: true },
      afterBindings: 3,
      stray: false,
    });
  });

  it("uploads every Worker whole on Apply settings now, though its upload and the script as read back are the same", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { core, connect } = await scriptsOf(clientId);
    // A release that leaves connect be: what's recorded matches it.
    await releaseCore(clientId, "export default { core: 2 };");
    const before = uploadsOf(account, connect);

    await runAgain(clientId);

    expect({
      before,
      connect: uploadsOf(account, connect),
      core: uploadsOf(account, core),
      status: await statusOf(clientId),
    }).toStrictEqual({ before: 1, connect: 2, core: 3, status: "done" });
  });

  it("uploads every Worker whole on the run after core failed its probe, though nothing they send changed", async () => {
    const manifest = await importRelease();
    const { account, clientId, held } = await setUp(manifest);
    cloudflare.coreOf(clientId).unhealthy = 5;
    const stopped = codeFrom(await failing(held));
    const { core, connect } = await scriptsOf(clientId);
    const before = {
      core: uploadsOf(account, core),
      connect: uploadsOf(account, connect),
    };
    await runClientProvision(context, await attempt(clientId));

    expect({
      stopped,
      before,
      after: {
        core: uploadsOf(account, core),
        connect: uploadsOf(account, connect),
      },
      status: await statusOf(clientId),
    }).toStrictEqual({
      stopped: "smoke_check_failed",
      before: { core: 1, connect: 1 },
      after: { core: 2, connect: 2 },
      status: "done",
    });
  });

  it("uploads the release before again on a rollback from a release whose upload landed with no answer", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { connect } = await scriptsOf(clientId);
    const later = await importRelease({
      notes: "feat(connect): later",
      connect: "export default { later: true };",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    // Connect's upload lands, and no attempt of it gets an answer.
    for (let lost = 0; lost < 4; lost += 1) {
      cloudflare.failNext(isUpload(connect), "lost");
    }
    const stopped = await failing(await attempt(clientId));
    const landed = codeOn(account, connect);
    await ageOutMarks(clientId);
    await startClientRelease(db, staff, await attempt(clientId), {
      rollback: true,
    });
    await runClientProvision(context, await attempt(clientId));

    expect({
      stopped: z.object({ status: z.number() }).parse(stopped).status,
      landed,
      rolledBack: codeOn(account, connect),
    }).toStrictEqual({
      stopped: 0,
      landed: "export default { later: true };",
      rolledBack: "export default {};",
    });
  });
});

describe("an upload Cloudflare refuses as a replay", () => {
  useStoreSecrets({ deployer: token });

  it("doesn't take a retry refused for its spent token (100312) as done when the attempt before it never landed: the script reads as before it", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { core } = await scriptsOf(clientId);
    const later = await importRelease({
      notes: "feat(core): later",
      core: "export default { core: 2 };",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    // Core's first attempt goes out whole, spends its token and never
    // lands (no answer); its retry is refused for the spent token. The
    // script stays at the migration it had, unmodified.
    let spent = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (spent || request.method !== "PUT" || !pathname.endsWith(`/${core}`)) {
        return await cloudflare.fetch(input, init);
      }
      spent = true;
      const form = await request.formData();
      const metadata = form.get("metadata");
      const { jwt } = z
        .object({ assets: z.object({ jwt: z.string() }) })
        .parse(
          JSON.parse(metadata instanceof Blob ? await metadata.text() : "{}")
        ).assets;
      account.spent.add(jwt);
      throw new TypeError("Network connection lost.");
    });
    const stopped = z
      .object({ codes: z.array(z.number()) })
      .parse(await failing(await attempt(clientId))).codes;

    expect({
      stopped,
      code: codeOn(account, core),
      status: await statusOf(clientId),
    }).toStrictEqual({
      stopped: [100_312],
      code: "export default { core: 1 };",
      status: "failed",
    });
  });

  it("takes a retry refused for its spent static files token (100312) as the attempt before it, whose answer was lost, once the script reads as it", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { core } = await scriptsOf(clientId);
    const later = await importRelease({
      notes: "feat(core): later",
      core: "export default { core: 2 };",
    });
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    const sentBefore = cloudflare.calls.filter(isUpload(core)).length;
    // Core's upload lands, and its answer is lost: the retry carries the
    // same token, which Cloudflare refuses as spent.
    cloudflare.failNext(isUpload(core), "lost");
    await runClientProvision(context, await attempt(clientId));

    expect({
      status: await statusOf(clientId),
      sent: cloudflare.calls.filter(isUpload(core)).length - sentBefore,
      landed: uploadsOf(account, core),
      code: codeOn(account, core),
    }).toStrictEqual({
      status: "done",
      // The upload, and its retry, refused: nothing sent a third time.
      sent: 2,
      landed: 2,
      code: "export default { core: 2 };",
    });
  });

  it("sends again without its Durable Object migrations an upload refused as having run them (10079), read at the migration before by a stale read", async () => {
    const first = await importRelease();
    const { account, clientId } = await liveClient(first);
    const { core } = await scriptsOf(clientId);
    const later = await importRelease(
      { notes: "feat(core): new class" },
      (entry) => ({
        ...entry,
        durableObjectMigrations: [
          ...entry.durableObjectMigrations,
          { tag: "v2", new_sqlite_classes: ["Extra"] },
        ],
      })
    );
    await startClientRelease(db, staff, await attempt(clientId), {
      releaseId: later.releaseId,
    });
    await runClientProvision(context, await attempt(clientId));
    const migrated = await migrationsRun(core);
    // Its settings run again; its first two reads of core lag behind, at
    // the migration before.
    let stale = 2;
    const detailsPath = new RegExp(`/scripts/${core}$`, "u");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const response = await cloudflare.fetch(input, init);
      if (
        request.method !== "GET" ||
        !detailsPath.test(new URL(request.url).pathname) ||
        stale === 0
      ) {
        return response;
      }
      stale -= 1;
      const body = z
        .object({
          result: z.object({ script: z.object({}).loose() }).loose(),
        })
        .loose()
        .parse(await response.json());
      return Response.json({
        ...body,
        result: {
          ...body.result,
          script: { ...body.result.script, migration_tag: "v1" },
        },
      });
    });
    await runAgain(clientId);

    expect({
      status: await statusOf(clientId),
      // The refused upload carried them; the one sent again didn't.
      migrationsSent: (await migrationsRun(core)) - migrated,
      tag: clientScripts(account).get(core)?.migrationTag,
    }).toStrictEqual({ status: "done", migrationsSent: 1, tag: "v2" });
  });
});
