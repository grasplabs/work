import { GraspError } from "@grasp-os/sdk/client";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { actionInvocation, invocationName } from "../src/action-invocation.ts";
import { readFunctionRequest } from "../src/app-functions.ts";
import { versionFiles } from "../src/apps.ts";
import { actionInvocations } from "../src/db/core/schema.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { withScreenReferences } from "../src/screen-references.ts";
import { buildScreens } from "../src/screens.ts";
import { StoreHost } from "../src/store-host.ts";
import { published } from "./apps.ts";
import { apiOf, notesFiles as files } from "./notes-client-app.ts";
import {
  personApi,
  openedApp,
  clientFor,
  titles,
  mockSessionIdp,
} from "./screen-client.ts";
import { person as sealedPerson } from "./sealed-apps.ts";

// The session client a screen's queries, mutations and actions go through
// (spec 10.1, 10.7.1), against core's real function route, as an approved
// screen's page relays them: a Notes App created, loaded, edited and
// deleted; a lost response recovered from its receipt, never saved twice;
// a cancelled save that still commits and can't be duplicated; caller
// keys reused for other input or past their receipt refused; an action's
// lost response recovered from its receipt and a resend joining it while
// it runs, never run twice, its receipt kept from another person and from
// its own person once their role narrowed; each invocation's object
// listed for as long as it holds anything; and arguments the operation
// can't take refused before anything is sent.

mockSessionIdp();

/** Why `promise` rejected: the structured error's code, category and details. */
const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof GraspError)) {
      throw error;
    }
    const { code, category, details } = error;
    return { code, category, details };
  }
  throw new Error("It resolved");
};

describe("the session client", { timeout: 120_000 }, () => {
  it("creates, loads, edits and deletes notes, with direct values", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);

    const id = await client.mutation(api.create, { title: "  Launch  " });
    const created = await client.query(api.get, { id });
    expect(created).toMatchObject({
      _id: id,
      title: "Launch",
      body: "",
      _rev: 1,
    });
    const edited = await client.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Launch plan",
      body: "Ship it",
    });
    expect(edited).toMatchObject({
      title: "Launch plan",
      body: "Ship it",
      _rev: 2,
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Launch plan"]);
    await expect(
      client.mutation(api.remove, { id, expectedRevision: 2 })
    ).resolves.toBeNull();
    // Null is the query's own answer for a note that isn't there.
    await expect(client.query(api.get, { id })).resolves.toBeNull();
  });

  it("rejects a stale revision with data.conflict, and an App's own failure as it threw it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const id = await client.mutation(api.create, { title: "Draft" });
    await client.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Theirs",
      body: "",
    });
    await expect(
      failureOf(
        client.mutation(api.update, {
          id,
          expectedRevision: 1,
          title: "Mine",
          body: "",
        })
      )
    ).resolves.toMatchObject({ code: "data.conflict", category: "domain" });
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Theirs",
    });
  });

  it("recovers a mutation whose answer was lost from its receipt, saving it once", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    net.drop(1);
    const id = await client.mutation(api.create, { title: "Once" });
    // The retry reached core and got the first commit's answer.
    expect(net.sent()).toBe(2);
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Once",
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Once"]);
  });

  it("makes each explicit call a submission of its own, and joins one with the same key and input", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const [first, second] = await Promise.all([
      client.mutation(api.create, { title: "Twin" }),
      client.mutation(api.create, { title: "Twin" }),
    ]);
    expect(first).not.toBe(second);
    const keyed = { idempotencyKey: "save-once" };
    const [one, again] = await Promise.all([
      client.mutation(api.create, { title: "Keyed" }, keyed),
      // Normalized as the host normalizes it: the same input.
      client.mutation(api.create, { title: " Keyed ", body: "" }, keyed),
    ]);
    expect(again).toBe(one);
    await expect(titles(client, api)).resolves.toHaveLength(3);
  });

  it("refuses a caller key reused for other input, and one whose receipt expired", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "monday-report" };
    const id = await client.mutation(api.create, { title: "Report" }, keyed);
    await expect(
      client.mutation(api.create, { title: "Report" }, keyed)
    ).resolves.toBe(id);
    await expect(
      failureOf(client.mutation(api.create, { title: "Other" }, keyed))
    ).resolves.toMatchObject({ code: "submission.key_conflict" });

    const store = opened.release.store?.storeId ?? "";
    await runInDurableObject(
      env.DATA_STORES.getByName(store),
      async (_instance, state) => {
        // The store's sweep, as at 31 days from now: past the receipt's
        // retention, within its tombstone's.
        await new StoreHost(state, env).sweepReceipts(
          new Date(Date.now() + 31 * 24 * 3_600_000)
        );
      }
    );
    await expect(
      failureOf(client.mutation(api.create, { title: "Report" }, keyed))
    ).resolves.toMatchObject({ code: "submission.expired" });
    await expect(titles(client, api)).resolves.toStrictEqual(["Report"]);
  });

  it("stops a cancelled caller waiting, while the save commits and can't be sent twice", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    const keyed = { idempotencyKey: "cancelled-save" };
    const controller = new AbortController();
    // The answer is lost, so the save is still reconciling when it aborts.
    net.drop(1);
    const waiting = client.mutation(
      api.create,
      { title: "Kept" },
      { ...keyed, signal: controller.signal }
    );
    controller.abort();
    await expect(failureOf(waiting)).resolves.toMatchObject({
      code: "submission.cancelled",
      details: { sent: true },
    });
    // The same key and input joins the submission still in flight.
    const id = await client.mutation(api.create, { title: "Kept" }, keyed);
    await expect(titles(client, api)).resolves.toStrictEqual(["Kept"]);
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Kept",
    });
    // Aborted before it was sent, nothing is.
    const before = net.sent();
    await expect(
      failureOf(
        client.mutation(
          api.create,
          { title: "Never" },
          { signal: AbortSignal.abort() }
        )
      )
    ).resolves.toMatchObject({
      code: "submission.cancelled",
      details: { sent: false },
    });
    expect(net.sent()).toBe(before);
  });

  it("releases only the reader that aborts a query", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await client.mutation(api.create, { title: "Shared" });
    const controller = new AbortController();
    const args = { pagination: { pageSize: 10 } };
    const aborted = client.query(api.list, args, { signal: controller.signal });
    const kept = client.query(api.list, args);
    controller.abort();
    await expect(failureOf(aborted)).resolves.toMatchObject({
      code: "query.cancelled",
    });
    await expect(kept).resolves.toMatchObject({
      items: [{ title: "Shared" }],
      hasMore: false,
    });
  });

  it("recovers an action whose answer was lost from its receipt, running it once", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    // The empty input may be left out: its default applies.
    await expect(client.action(api.echo)).resolves.toBe("hello");
    // The action committed its note, then its answer was lost on the way
    // back: the resend under its key answers the receipt.
    net.drop(1);
    const before = net.sent();
    const keyed = { idempotencyKey: "stamp-once" };
    const first = await client.action(api.stamp, { title: "Once" }, keyed);
    expect(net.sent()).toBe(before + 2);
    // A deliberate call under the same key answers it again.
    await expect(
      client.action(api.stamp, { title: "Once" }, keyed)
    ).resolves.toStrictEqual(first);
    await expect(titles(client, api)).resolves.toStrictEqual(["Once"]);
    await expect(
      failureOf(client.action(api.stamp, { title: "Other" }, keyed))
    ).resolves.toMatchObject({ code: "submission.key_conflict" });
  });

  it("joins an action still running when it is sent again under its key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // Two tabs, so neither client joins the other's call on its own side.
    const one = clientFor(opened).client;
    const two = clientFor(opened).client;
    const keyed = { idempotencyKey: "stamp-slowly" };
    const input = { title: "Joined", pauseMs: 1500 };
    const first = one.action(api.stamp, input, keyed);
    await scheduler.wait(300);
    const [started, joined] = await Promise.all([
      first,
      two.action(api.stamp, input, keyed),
    ]);
    expect(joined).toStrictEqual(started);
    await expect(titles(one, api)).resolves.toStrictEqual(["Joined"]);
  });

  it("keeps an action's receipt from another person under the same key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const keyed = { idempotencyKey: "everyones-key" };
    const input = { title: "Mine" };
    const mine = await clientFor(opened).client.action(api.stamp, input, keyed);
    // From the admin's own screen: an invocation of theirs, run for them.
    const { client: theirs } = clientFor(
      opened,
      opened.admin.api.screens,
      true
    );
    const their = await theirs.action(api.stamp, input, keyed);
    expect(their.token).not.toBe(mine.token);
    // The builder's invocation itself, reached in the admin's name.
    const request = JSON.stringify({
      reference: {
        resourceId: api.stamp.resourceId,
        resourceVersion: api.stamp.resourceVersion,
        contractId: api.stamp.contractId,
        fingerprint: api.stamp.fingerprint,
        kind: "action",
      },
      input: { title: "Mine", pauseMs: 0 },
      idempotencyKey: keyed.idempotencyKey,
    });
    const app = appIdSchema.parse(opened.app);
    const call = readFunctionRequest(request);
    const name = await invocationName(
      opened.builderId,
      app,
      call,
      keyed.idempotencyKey,
      false
    );
    const frames = await actionInvocation(env, name).open({
      by: { userId: opened.admin.userId, role: "admin", teams: [] },
      access: "the admin's",
      app,
      name,
      call,
      streaming: false,
      attach: false,
    });
    const refused = z
      .object({ result: z.object({ error: z.object({ code: z.string() }) }) })
      .parse(JSON.parse(await new Response(frames).text()));
    expect(refused.result.error.code).toBe("operation.not_found");
  });

  it("withholds an action's receipt from its person once their role narrowed", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "before-demotion" };
    await client.action(api.stamp, { title: "Budget" }, keyed);
    await opened.admin.api.members.setRole(opened.builderId, "user");
    // Withheld, never told as a refusal: the action ran under that key.
    await expect(
      failureOf(client.action(api.stamp, { title: "Budget" }, keyed))
    ).resolves.toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
      details: {
        idempotencyKey: keyed.idempotencyKey,
        refusal: "operation.access_changed",
      },
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Budget"]);
  });

  it("keeps an action's outcome unknown when its resend after a lost answer is refused", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    const keyed = { idempotencyKey: "lost-then-signed-out" };
    // Its answer is lost, and the person was removed before the resend.
    net.drop(1, async () => {
      await opened.admin.api.members.remove(opened.builderId);
    });
    await expect(
      failureOf(client.action(api.stamp, { title: "Ran" }, keyed))
    ).resolves.toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
      details: { idempotencyKey: keyed.idempotencyKey },
    });
  });

  it("withholds an action's answer from its person whose role narrowed while it ran", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "demoted-while-running" };
    const running = failureOf(
      client.action(api.stamp, { title: "Ran", pauseMs: 1500 }, keyed)
    );
    await scheduler.wait(300);
    await opened.admin.api.members.setRole(opened.builderId, "user");
    await expect(running).resolves.toMatchObject({
      code: "submission.outcome_unknown",
      details: {
        idempotencyKey: keyed.idempotencyKey,
        refusal: "operation.access_changed",
      },
    });
  });

  it("withholds an action's answer from its person removed while it ran, as an outcome unknown on its first answer", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "removed-while-running" };
    const running = failureOf(
      client.action(api.stamp, { title: "Ran", pauseMs: 1500 }, keyed)
    );
    await scheduler.wait(300);
    await opened.admin.api.members.remove(opened.builderId);
    await expect(running).resolves.toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
      details: {
        idempotencyKey: keyed.idempotencyKey,
        refusal: "auth.unauthenticated",
      },
    });
  });

  it("keeps an action's outcome unknown, with its key, when it is sent again past its receipt", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "kept-too-long" };
    const input = { title: "Ran" };
    await client.action(api.stamp, input, keyed);
    const request = JSON.stringify({
      reference: {
        resourceId: api.stamp.resourceId,
        resourceVersion: api.stamp.resourceVersion,
        contractId: api.stamp.contractId,
        fingerprint: api.stamp.fingerprint,
        kind: "action",
      },
      input: { ...input, pauseMs: 0 },
      idempotencyKey: keyed.idempotencyKey,
    });
    const name = await invocationName(
      opened.builderId,
      appIdSchema.parse(opened.app),
      readFunctionRequest(request),
      keyed.idempotencyKey,
      false
    );
    const stub = actionInvocation(env, name);
    // Its receipt kept past its time, so only its tombstone is left.
    await runInDurableObject(stub, (_instance, state) => {
      const record = z
        .object({ settledAt: z.number() })
        .loose()
        .parse(state.storage.kv.get("invocation"));
      state.storage.kv.put("invocation", {
        ...record,
        settledAt: Date.now() - 16 * 60_000,
      });
    });
    await runDurableObjectAlarm(stub);
    // A form that stayed uncertain that long sends it again: it ran, so
    // its outcome is unknown, never a failure a fresh key would repeat.
    await expect(
      failureOf(client.action(api.stamp, input, keyed))
    ).resolves.toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
      details: {
        idempotencyKey: keyed.idempotencyKey,
        refusal: "submission.expired",
      },
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Ran"]);
  });

  it("lists an action's invocation once, for as long as its object holds anything", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "listed-once" };
    const input = { title: "Listed" };
    const first = await client.action(api.stamp, input, keyed);
    await expect(client.action(api.stamp, input, keyed)).resolves.toStrictEqual(
      first
    );
    const listed = async () =>
      await drizzle(env.DB)
        .select({
          name: actionInvocations.name,
          personId: actionInvocations.personId,
          streaming: actionInvocations.streaming,
        })
        .from(actionInvocations)
        .where(eq(actionInvocations.appId, opened.app));
    const rows = await listed();
    expect(
      rows.map(({ personId, streaming }) => ({ personId, streaming }))
    ).toStrictEqual([{ personId: opened.builderId, streaming: false }]);
    // The row names the object that holds the receipt: kept past its
    // time, it leaves a tombstone, still listed.
    const stub = actionInvocation(env, rows[0]?.name ?? "");
    const held = async () =>
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.get("invocation")
      );
    await runInDurableObject(stub, (_instance, state) => {
      const record = z
        .object({ settledAt: z.number() })
        .loose()
        .parse(state.storage.kv.get("invocation"));
      state.storage.kv.put("invocation", {
        ...record,
        settledAt: Date.now() - 16 * 60_000,
      });
    });
    await runDurableObjectAlarm(stub);
    await expect(Promise.all([held(), listed()])).resolves.toMatchObject([
      { state: "expired" },
      rows,
    ]);
    // Once the tombstone goes, the object holds nothing and isn't listed.
    await runDurableObjectAlarm(stub);
    await expect(Promise.all([held(), listed()])).resolves.toStrictEqual([
      undefined,
      [],
    ]);
  });

  it("withholds an action's answer made under a release revoked while it ran, its outcome unknown with its key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "made-under-v1" };
    // It saves at once, then takes a while before it answers.
    const running = failureOf(
      client.action(api.stamp, { title: "Ran", thenMs: 2500 }, keyed)
    );
    await expect
      .poll(async () => await titles(client, api))
      .toStrictEqual(["Ran"]);
    // Version 2 published, and version 1 revoked, while it runs.
    const { version } = await opened.builder.api.apps.files.commit(
      opened.app,
      {
        ...files,
        "app.ts": `${files["app.ts"] ?? ""}\n// The second version.\n`,
      },
      "Second"
    );
    await opened.builder.api.apps.versions.setCurrent(opened.app, version);
    await revokeRelease(
      env,
      await sealedPerson("admin"),
      { app: appIdSchema.parse(opened.app), version: 1 },
      "Leaks data"
    );
    await expect(running).resolves.toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
      details: {
        idempotencyKey: keyed.idempotencyKey,
        // Its frame was opened on version 1: its build is revoked with it.
        refusal: "screen.revoked",
      },
    });
  });

  it("answers an action whose receipt is larger than a screen takes as uncertain, with its key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const failure = await failureOf(client.action(api.big));
    expect(failure).toMatchObject({
      code: "screen.answer_too_large",
      category: "uncertain",
    });
    expect(failure.details).toHaveProperty("idempotencyKey");
  });

  it("saves from two tabs that read more at once than the person's request budget holds", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const tabs = [clientFor(opened).client, clientFor(opened).client];
    // Each tab reads a dozen queries at once and saves meanwhile: more
    // than the budget's burst between them, so some are refused, and the
    // saves wait for it to give requests back rather than fail.
    const saved = await Promise.all(
      tabs.map(async (client, tab) => {
        const reads = Array.from(
          { length: 12 },
          async (_, index) =>
            await client.query(api.list, {
              pagination: { pageSize: index + 1 },
            })
        );
        const id = await client.mutation(api.create, {
          title: `From tab ${tab + 1}`,
        });
        await Promise.all(reads);
        return id;
      })
    );
    expect(new Set(saved).size).toBe(2);
    const { client } = clientFor(opened);
    await expect(titles(client, api)).resolves.toStrictEqual(
      expect.arrayContaining(["From tab 1", "From tab 2"])
    );
  });

  it("refuses arguments and options the call can't take before sending anything", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    await expect(
      failureOf(client.mutation(api.create, { title: "   " }))
    ).resolves.toMatchObject({
      code: "contract.invalid_args",
      category: "contract",
      details: { issues: [{ path: ["title"] }] },
    });
    await expect(
      failureOf(
        client.mutation(api.create, { title: "Fine" }, { idempotencyKey: "" })
      )
    ).resolves.toMatchObject({ code: "submission.key_invalid" });
    const id = await client.mutation(api.create, { title: "Real" });
    const sent = net.sent();
    // A query takes no key: the type refuses it, and so does the client.
    await expect(
      // @ts-expect-error -- a query takes no idempotency key
      client.query(api.get, { id }, { idempotencyKey: "no" })
    ).rejects.toThrow(TypeError);
    // A reference that isn't a public query.
    await expect(
      // @ts-expect-error -- a mutation isn't a query, and the client checks
      failureOf(client.query(api.create, { id }))
    ).resolves.toMatchObject({ code: "contract.invalid_request" });
    expect(net.sent()).toBe(sent);
  });
});
/** A screen of the Notes App whose component runs `body` first. */
const screen = (body: string): string =>
  `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { api } from "#grasp";

export default function Notes() {
${body}
  return null;
}
`;

/** How many inspected manifests core keeps. */
const inspections = async (): Promise<number> => {
  const { objects } = await env.FILES.list({ prefix: "inspections/" });
  return objects.length;
};
/** The diagnostics of version 1 of an App holding `files`, as core builds its screens. */
const diagnosticsOf = async (
  appFiles: Record<string, string>
): Promise<string[]> => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await published(id);
  const { version } = await builder.api.apps.files.commit(
    id,
    appFiles,
    "First"
  );
  const build = await buildScreens(
    env,
    await withScreenReferences(
      env,
      appIdSchema.parse(id),
      version,
      await versionFiles(env, appIdSchema.parse(id), version)
    ),
    "app-test"
  );
  return build.diagnostics
    .filter(({ severity }) => severity === "error")
    .map(({ message }) => message);
};

describe("a screen's build", { timeout: 120_000 }, () => {
  it("builds a saved or drafted version's screens with the references its own code generates", async () => {
    // A save and a draft's check build alike (save-builds.ts): nothing of
    // either is sealed yet, so the references come from the files.
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    await published(id);
    const { builds } = await builder.api.apps.files.commit(id, files, "First");
    expect(builds.screens).toMatchObject({ status: "ok", diagnostics: [] });
    const broken = await builder.api.apps.files.commit(
      id,
      {
        ...files,
        "screens/notes.tsx": screen(
          '  useQuery(api.notes.get, { noteId: "x" });'
        ),
      },
      "Second"
    );
    expect(broken.builds.screens.status).toBe("failed");
  });

  it("inspects the same server code once, however often a save brings it", async () => {
    const builder = await personApi("builder");
    // Server code of its own, so no other test inspected it already.
    const operations = `${files["operations/notes.ts"] ?? ""}\n// ${crypto.randomUUID()}\n`;
    const own = { ...files, "operations/notes.ts": operations };
    const before = await inspections();
    const { id } = await builder.api.apps.create({ name: "Notes" });
    await published(id);
    await builder.api.apps.files.commit(id, own, "First");
    // A screen changed, the server code not: what was inspected is kept.
    await builder.api.apps.files.commit(
      id,
      { ...own, "screens/notes.tsx": screen("") },
      "Second"
    );
    await expect(inspections()).resolves.toBe(before + 1);
    // Other server code is inspected for itself.
    await builder.api.apps.files.commit(
      id,
      {
        ...own,
        "operations/notes.ts": operations.replace(
          '.default("hello")',
          '.default("hi")'
        ),
      },
      "Third"
    );
    await expect(inspections()).resolves.toBe(before + 2);
  });

  it("loads the App's references and the React SDK into the screen", async () => {
    const opened = await openedApp();
    const build = await buildScreens(
      env,
      await withScreenReferences(
        env,
        appIdSchema.parse(opened.app),
        opened.release.manifest.resourceVersion,
        await versionFiles(
          env,
          appIdSchema.parse(opened.app),
          opened.release.manifest.resourceVersion
        )
      ),
      "app-test"
    );
    if (!build.ok) {
      throw new Error("The screen didn't build");
    }
    const closure = build.screens["app~screens~notes.js"];
    expect(closure?.modules).toStrictEqual([
      "app~.grasp~references.js",
      "app~screens~notes.js",
    ]);
    expect(closure?.kitModules).toContain("@grasp-os~sdk~react.js");
  });

  it("fails the type check on arguments a reference doesn't take, without a cast", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": screen(`  useQuery(api.notes.get, { noteId: "x" });
  const create = useMutation(api.notes.create);
  void create();`),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("noteId"),
      expect.stringContaining("Expected 1-2 arguments, but got 0"),
    ]);
  });

  it("refuses a screen that makes its own client", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": `import { GraspClient } from "@grasp-os/sdk/client";
export default function Notes() {
  return <p>{String(GraspClient)}</p>;
}
`,
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("the platform's: it makes the session client"),
    ]);
  });

  it("tells an App without server code that it has no references yet", async () => {
    await expect(
      diagnosticsOf({
        "screens/notes.tsx": screen("  void api;"),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("which this App doesn't have yet"),
    ]);
  });

  it("builds forms of the operations, the record and a native schema, typed by what they bind", async () => {
    const formScreen = `import { v } from "@grasp-os/sdk";
import type { ReturnOf } from "@grasp-os/sdk";
import { useForm } from "@grasp-os/sdk/react";
import { Form, FormError, SubmitButton, TextareaField, TextField } from "@grasp-os/ui/form";
import { api } from "#grasp";

type Note = NonNullable<ReturnOf<typeof api.notes.get>>;

const searchSchema = v.object({ search: v.string().trim().min(1) });

export function Editor({ note }: { note: Note }) {
  const create = useForm(api.notes.create, { defaultValues: { title: "", body: "" }, resetOnSuccess: true });
  const edit = useForm(api.notes.update, {
    record: note,
    fields: ["title", "body"],
    args: (baseline) => ({ id: baseline._id, expectedRevision: baseline._rev }),
  });
  const search = useForm(searchSchema, { defaultValues: { search: "" }, onSubmit: (values) => values.search });
  return (
    <>
      <Form form={create}>
        <TextField form={create} label="Title" name="title" />
        <TextareaField form={create} label="Body" name="body" />
        <FormError form={create} />
        <SubmitButton form={create}>Create note</SubmitButton>
      </Form>
      <Form form={edit}>
        <TextField form={edit} label="Title" name="title" />
        <SubmitButton form={edit}>Save changes</SubmitButton>
      </Form>
      <Form form={search}>
        <TextField form={search} label="Search" name="search" />
        <SubmitButton form={search}>Apply filter</SubmitButton>
      </Form>
    </>
  );
}

export default function Notes() {
  return null;
}
`;
    await expect(
      diagnosticsOf({ ...files, "screens/notes.tsx": formScreen })
    ).resolves.toStrictEqual([]);
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": formScreen.replace(
          '<TextField form={create} label="Title" name="title" />',
          '<TextField form={create} label="Owner" name="owner" />'
        ),
      })
    ).resolves.toStrictEqual([expect.stringContaining('"owner"')]);
  });

  it("gives screens only the native values of the SDK's root", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": `import { app } from "@grasp-os/sdk";
export default function Notes() {
  return <p>{typeof app}</p>;
}
`,
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("Screens import only { v } from @grasp-os/sdk"),
    ]);
  });
});
