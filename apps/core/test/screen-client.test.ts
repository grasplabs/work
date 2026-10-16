import type { OperationReference, ReferenceKind } from "@grasp-os/sdk";
import { GraspError } from "@grasp-os/sdk/client";
import { clientInternals, GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  querySubscriptionLimits,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { actionInvocation, invocationName } from "../src/action-invocation.ts";
import { readFunctionRequest } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { versionFiles } from "../src/apps.ts";
import { appHost, inJurisdiction } from "../src/durable-objects.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { withScreenReferences } from "../src/screen-references.ts";
import { buildScreens } from "../src/screens.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { StoreHost } from "../src/store-host.ts";
import { storeMaxWatches } from "../src/store-watches.ts";
import { pastAccessRecheck, requestGranted } from "./apps.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { newTeam, readCollection } from "./knowledge.ts";
import { apiOf, notesFiles as files, referenceTo } from "./notes-client-app.ts";
import { person as sealedPerson } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  callAuth,
  openRpc,
  outcome,
  routed,
  signedInApi,
  unique,
} from "./sign-in.ts";

// The session client a screen's queries, mutations and actions go through
// (spec 10.1, 10.7.1), against core's real function route, as an approved
// screen's page relays them: a Notes App created, loaded, edited and
// deleted; a lost response recovered from its receipt, never saved twice;
// a cancelled save that still commits and can't be duplicated; caller
// keys reused for other input or past their receipt refused; an action's
// lost response recovered from its receipt and a resend joining it while
// it runs, never run twice, its receipt kept from another person and from
// its own person once their role narrowed; and arguments the operation
// can't take refused before anything is sent.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * A builder's Notes App, made current, its screen approved by an admin and
 * opened: the release, the screen's lease, and the builder's session.
 */
const openedApp = async (appFiles: Record<string, string> = files) => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(
    id,
    appFiles,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const { lease } = await builder.api.screens.open(id, "notes");
  // The frame's connection presents its build, as the page does.
  await builder.api.screens.present(id, lease);
  const { lease: adminLease } = await admin.api.screens.open(id, "notes");
  const release = await loadRelease(env, id, version);
  return {
    app: id,
    lease,
    cookie: builder.session,
    userId: builder.userId,
    release,
    builder,
    screens: builder.api.screens,
    builderId: builder.userId,
    admin: { ...admin, lease: adminLease, cookie: admin.session },
  };
};

type Opened = Awaited<ReturnType<typeof openedApp>>;

/** Where a page's live queries go: one connection's `screens`, presented. */
type Screens = Opened["screens"];

/**
 * What the page does with a call the frame sends (apps/web's
 * screen-host.ts): posts it to core's function route under the screen's
 * lease, naming the person it was opened for, answers core's answer, and
 * rejects a refusal with its code; and
 * follows a query over its connection to core (`watchQuery`), the
 * callback's disposal telling the client core let go of it.
 */
const pageTransport = (
  {
    app,
    lease,
    cookie,
    userId,
  }: Pick<Opened, "app" | "lease" | "cookie" | "userId">,
  screens: Screens
): ClientTransport => ({
  watch: async (request, onSnapshot, onLost) => {
    const callback = Object.assign(
      (push: unknown): void => {
        onSnapshot(push);
      },
      { [Symbol.dispose]: onLost }
    );
    const subscription = await screens.watchQuery(
      app,
      lease,
      request,
      callback
    );
    return {
      release: () => {
        void subscription.release().catch(() => {
          // Gone with the connection.
        });
      },
    };
  },
  call: async (request) => {
    const response = await routed(`${appFunctionPath}/${app}`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie,
        [screenLeaseHeader]: lease,
        [screenPersonHeader]: userId,
      },
      body: request,
    });
    const answer: unknown = await response.json();
    if (response.ok) {
      return answer;
    }
    const payload = errorPayloadSchema.parse(answer);
    // As the page does: of a refusal's details, how long to wait.
    const retryAfterMs = payload.details?.retryAfterMs;
    throw Object.assign(new Error(payload.message), {
      code: payload.code,
      ...(typeof retryAfterMs === "number"
        ? { details: { retryAfterMs } }
        : {}),
    });
  },
});

/** The network between page and core, which can drop answers on the way back. */
const network = (transport: ClientTransport) => {
  let dropping = 0;
  let meanwhile: (() => Promise<unknown>) | undefined;
  let sent = 0;
  return {
    transport: {
      watch: transport.watch,
      call: async (request: string, app: string) => {
        sent += 1;
        const answer = await transport.call(request, app);
        if (dropping > 0) {
          dropping -= 1;
          await meanwhile?.();
          // The request reached core; its answer didn't come back.
          throw new Error("The connection was reset.");
        }
        return answer;
      },
    } satisfies ClientTransport,
    /** Drops the next `count` answers, doing `then` before each is lost. */
    drop: (count: number, then?: () => Promise<unknown>) => {
      dropping = count;
      meanwhile = then;
    },
    /** How many requests reached core so far. */
    sent: () => sent,
  };
};

/**
 * A client over the page's transport, as the frame's runtime mounts it:
 * the builder's, or the admin's with `asAdmin`.
 */
const clientFor = (
  opened: Opened,
  screens: Screens = opened.screens,
  asAdmin = false
) => {
  const seat = asAdmin
    ? {
        app: opened.app,
        lease: opened.admin.lease,
        cookie: opened.admin.cookie,
        userId: opened.admin.userId,
      }
    : opened;
  const net = network(pageTransport(seat, screens));
  return { client: new GraspClient(net.transport), net };
};

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

/** The titles of the notes the App holds, newest first. */
const titles = async (client: GraspClient, api: ReturnType<typeof apiOf>) => {
  const page = await client.query(api.list, { pagination: {} });
  return page.items.map((note) => note.title);
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
        refusal: "version.revoked",
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

describe("a screen's build", { timeout: 120_000 }, () => {
  it("builds a saved or drafted version's screens with the references its own code generates", async () => {
    // A save and a draft's check build alike (save-builds.ts): nothing of
    // either is sealed yet, so the references come from the files.
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
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

  /** The diagnostics of version 1 of an App holding `files`, as core builds its screens. */
  const diagnosticsOf = async (
    appFiles: Record<string, string>
  ): Promise<string[]> => {
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
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
      )
    );
    return build.diagnostics
      .filter(({ severity }) => severity === "error")
      .map(({ message }) => message);
  };

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
      )
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

// Live queries (spec 11): what a screen's `useQuery` does through the same
// client, over core's real connection, function route and store. A query
// is followed once however many components read it; a change saved
// elsewhere reaches it without the screen asking; pushes stay in order,
// never cross people, stop with access, survive a store restart, and
// pile up no further than one replacement each.

/**
 * What a component reading a query sees, as `useQuery` subscribes:
 * the shared entry's snapshot, as it is now.
 */
const reading = (client: GraspClient, reference: unknown, args: unknown) => {
  const internals = clientInternals(client);
  const entry = internals.entry(reference, args);
  const stop = internals.subscribe(entry, () => {
    // `useSyncExternalStore` reads the snapshot again; the test reads it
    // when it looks.
  });
  return { stop, now: () => entry.snapshot };
};

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

/** Once `look` passes. */
const eventually = async (look: () => void): Promise<void> => {
  await vi.waitFor(look, pushWait);
};

/** The titles a list snapshot shows, or what it failed with. */
const shown = (snapshot: { value: unknown; error: GraspError | undefined }) => {
  if (snapshot.error !== undefined) {
    return snapshot.error.code;
  }
  const page = z
    .object({ items: z.array(z.object({ title: z.string() })) })
    .safeParse(snapshot.value);
  return page.success ? page.data.items.map(({ title }) => title) : undefined;
};

/**
 * A transport that counts what it follows and holds the answers of
 * calls while `held` is set, to deliver them late.
 */
const countingTransport = (transport: ClientTransport) => {
  let follows = 0;
  let gate: Promise<unknown> | undefined;
  return {
    transport: {
      call: async (request: string, app: string) => {
        const answer = await transport.call(request, app);
        await gate;
        return answer;
      },
      watch: async (...args: Parameters<ClientTransport["watch"]>) => {
        follows += 1;
        return await transport.watch(...args);
      },
    } satisfies ClientTransport,
    follows: () => follows,
    /** Holds every answer until the function it answers is called. */
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<null>();
      gate = promise;
      return () => {
        gate = undefined;
        resolve(null);
      };
    },
  };
};

/** A query's call as the client sends it, for a raw subscription. */
const requestOf = (
  reference: OperationReference<unknown, unknown, ReferenceKind>,
  input: unknown
): string =>
  JSON.stringify({
    reference: {
      resourceId: reference.resourceId,
      resourceVersion: reference.resourceVersion,
      contractId: reference.contractId,
      fingerprint: reference.fingerprint,
      kind: reference.kind,
    },
    input,
  });

/**
 * Runs `run` as if `minutes` had passed: following counts as a request,
 * and a person asks an App's screens twenty things at once at most.
 */
const later = async <T>(minutes: number, run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes * 60_000 });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** The App's store's object. */
const storeObjectOf = (opened: Opened) => {
  const storeId = opened.release.store?.storeId;
  if (storeId === undefined) {
    throw new Error("The Notes App has a store");
  }
  return inJurisdiction(env, env.DATA_STORES).getByName(storeId);
};

describe("live queries", { timeout: 120_000 }, () => {
  it("follows a query once for every reader, and shows a change saved in another tab without asking", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const counted = countingTransport(pageTransport(opened, opened.screens));
    const client = new GraspClient(counted.transport);
    const args = { pagination: { pageSize: 10 } };
    const first = reading(client, api.list, args);
    const second = reading(client, api.list, args);
    await eventually(() => {
      expect(shown(first.now())).toStrictEqual([]);
    });
    // A component that renders again lets go and subscribes in one go,
    // as React does: the subscription stays.
    first.stop();
    const again = reading(client, api.list, args);

    // Another tab of the same session: its own connection to core.
    const { core } = await openRpc(opened.cookie);
    const otherScreens = core.authenticate().screens;
    await otherScreens.present(opened.app, opened.lease);
    const other = clientFor(opened, otherScreens).client;
    await other.mutation(api.create, { title: "From the other tab" });

    await eventually(() => {
      expect(shown(second.now())).toStrictEqual(["From the other tab"]);
    });
    expect({
      again: shown(again.now()),
      follows: counted.follows(),
    }).toStrictEqual({
      again: ["From the other tab"],
      follows: 1,
    });
  });

  it("never shows one person's records to another, and pushes each their own", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const owner = clientFor(opened).client;
    const theirs = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    ).client;
    const args = { pagination: { pageSize: 10 } };
    const ownerList = reading(owner, api.list, args);
    const memberList = reading(theirs, api.list, args);
    await eventually(() => {
      expect(shown(memberList.now())).toStrictEqual([]);
    });

    await owner.mutation(api.create, { title: "The owner's" });
    await theirs.mutation(api.create, { title: "The member's" });

    await eventually(() => {
      expect({
        owner: shown(ownerList.now()),
        member: shown(memberList.now()),
      }).toStrictEqual({ owner: ["The owner's"], member: ["The member's"] });
    });
  });

  it("never lets a late answer of a read replace a newer push, followed or no longer", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const counted = countingTransport(pageTransport(opened, opened.screens));
    const client = new GraspClient(counted.transport);
    const id = await client.mutation(api.create, { title: "First" });
    const note = reading(client, api.get, { id });
    await eventually(() => {
      expect(note.now().value).toMatchObject({ _rev: 1 });
    });

    // A read whose answer is held back while the note moves on.
    const open = counted.hold();
    const late = client.query(api.get, { id });
    const other = clientFor(opened).client;
    await other.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Second",
      body: "",
    });
    await eventually(() => {
      expect(note.now().value).toMatchObject({ _rev: 2, title: "Second" });
    });
    // Nobody follows the note now: the read sent before the push is still
    // older than what it shows.
    note.stop();
    await scheduler.wait(0);
    open();
    await late;

    expect(note.now().value).toMatchObject({ _rev: 2, title: "Second" });
  });

  it("clears what a screen shows once the person loses access, before anything more reaches it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const theirs = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    ).client;
    await theirs.mutation(api.create, { title: "Mine" });
    const list = reading(theirs, api.list, { pagination: {} });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual(["Mine"]);
    });

    await opened.builder.api.apps.members.remove(opened.app, them);
    const owner = clientFor(opened).client;
    // Any commit to what the query read has it read again, as them.
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Elsewhere" });
          expect(list.now().error).toBeDefined();
        },
        { timeout: 10_000, interval: 250 }
      );
    });

    expect({
      value: list.now().value,
      code: list.now().error?.code,
    }).toStrictEqual({ value: undefined, code: "app.not_found" });
  });

  it("lets the store drop a watch core let go of, even when telling it so failed", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    // The store stays up, but core's word that it let go of a watch never
    // arrives.
    let undo: (() => void) | undefined;
    await runInDurableObject(store, (instance) => {
      // SAFETY: a store's object's prototype holds its methods.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const methods = Object.getPrototypeOf(instance) as Record<
        string,
        unknown
      >;
      const original = methods.unwatch;
      methods.unwatch = () => {
        throw new Error("Lost on the way.");
      };
      undo = () => {
        methods.unwatch = original;
      };
    });
    try {
      const { client } = clientFor(opened);
      const list = reading(client, api.list, { pagination: {} });
      await eventually(() => {
        expect(shown(list.now())).toStrictEqual([]);
      });
      list.stop();
      await scheduler.wait(500);

      // The store's sweep asks each watcher whether it is still there:
      // one core let go of says no, so the next sweep finds none left to
      // keep its alarm for.
      await runDurableObjectAlarm(store);
      await runDurableObjectAlarm(store);
      const alarm = await runInDurableObject(
        store,
        async (_instance, state) => await state.storage.getAlarm()
      );
      expect(alarm).toBeNull();
    } finally {
      undo?.();
    }
  });

  it("follows again after the store restarts, and shows a change saved just before", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const list = reading(client, api.list, { pagination: {} });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual([]);
    });

    const other = clientFor(opened).client;
    await other.mutation(api.create, { title: "Before the restart" });
    // Restarted, as a deploy restarts it, right after the commit: what
    // it held of the screen's watch is gone with it.
    await runInDurableObject(storeObjectOf(opened), (_store, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual(["Before the restart"]);
    });
    await other.mutation(api.create, { title: "After the restart" });

    await eventually(() => {
      expect(shown(list.now())).toStrictEqual([
        "After the restart",
        "Before the restart",
      ]);
    });
  });

  it("keeps one replacement for a page that doesn't take its pushes, and sends the latest once it does", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const received: { revision: number; titles: string[] }[] = [];
    const taken = Promise.withResolvers<null>();
    let first = true;
    const pushed = z.object({
      revision: z.number(),
      result: z.object({
        ok: z.literal(true),
        value: z.object({ items: z.array(z.object({ title: z.string() })) }),
      }),
    });
    // The page takes the first push only once the test lets it.
    const callback = async (push: unknown): Promise<void> => {
      const { revision, result } = pushed.parse(push);
      received.push({
        revision,
        titles: result.value.items.map(({ title }) => title),
      });
      if (first) {
        first = false;
        await taken.promise;
      }
    };
    await opened.screens.watchQuery(
      opened.app,
      opened.lease,
      requestOf(api.list, { pagination: { pageSize: 50 } }),
      // Core waits for what a page's callback answers: that is the point.
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });

    const { client } = clientFor(opened);
    const saves = 8;
    for (let note = 1; note <= saves; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save after the other
      await client.mutation(api.create, { title: `Note ${note}` });
    }
    // Room for the reads those saves cause, while the page holds the first.
    await scheduler.wait(1000);
    taken.resolve(null);
    await eventually(() => {
      expect(received.at(-1)?.titles).toHaveLength(saves);
    });

    const revisions = received.map(({ revision }) => revision);
    expect({
      inOrder: revisions.every(
        (revision, at) => at === 0 || revision > (revisions[at - 1] ?? 0)
      ),
      fewerThanSaves: received.length < 1 + saves,
    }).toStrictEqual({ inOrder: true, fewerThanSaves: true });
  });

  it("holds a page to its live queries at once", async () => {
    const opened = await openedApp();
    const follow = async (n: number) =>
      await outcome(
        opened.screens.watchQuery(
          opened.app,
          opened.lease,
          JSON.stringify({ n }),
          () => {
            // Each is refused as a call it can't read, and stays followed.
          }
        )
      );
    const answers: string[] = [];
    // Following counts as a request: twenty a moment, as a screen would.
    for (let minute = 0; minute < 6; minute += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one minute after the other
      const batch = await later(
        minute + 1,
        async () =>
          await Promise.all(
            Array.from(
              { length: 17 },
              async (_, at) => await follow(minute * 17 + at)
            )
          )
      );
      answers.push(...batch);
    }

    expect({
      followed: answers.filter((answer) => answer === "ok").length,
      refused: [...new Set(answers.filter((answer) => answer !== "ok"))],
    }).toStrictEqual({ followed: 100, refused: ["screen.too_many_queries"] });
  });
});

/** A push of core's, as a raw subscription gets it. */
const pushSchema = z.object({
  revision: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});
type Push = z.infer<typeof pushSchema>;

/**
 * A page's callback for a raw subscription: what reached it, and whether
 * core let go of it.
 */
const pageFollower = () => {
  const received: Push[] = [];
  const state = { released: false };
  const callback = Object.assign(
    (push: unknown): void => {
      received.push(pushSchema.parse(push));
    },
    {
      [Symbol.dispose]: (): void => {
        state.released = true;
      },
    }
  );
  return { received, state, callback };
};

/** The titles a push shows, or the code it was refused with. */
const titlesOf = (push: Push | undefined): string[] | string | null => {
  if (push === undefined) {
    return null;
  }
  if (!push.result.ok) {
    return push.result.error.code;
  }
  return z
    .object({ items: z.array(z.object({ title: z.string() })) })
    .parse(push.result.value)
    .items.map(({ title }) => title);
};

/**
 * Retitles every note and moves the table on in the store's own
 * database, as a write nobody told the store's watches of would: what a
 * live query only finds by looking again.
 */
const silentlyRetitle = async (opened: Opened, title: string) => {
  await runInDurableObject(storeObjectOf(opened), (_store, state) => {
    state.storage.sql.exec(
      "UPDATE sdk_records SET value_json = json_set(value_json, '$.title', ?), revision = revision + 1",
      title
    );
    state.storage.sql.exec("UPDATE sdk_tables SET generation = generation + 1");
  });
};

/** A member of `opened`'s App, with their own screen's lease and client. */
const memberOf = async (opened: Opened) => {
  const member = await personApi("builder");
  const them = { type: "person", id: member.userId } as const;
  await opened.builder.api.apps.members.add(opened.app, {
    ...them,
    role: "user",
  });
  const { lease } = await member.api.screens.open(opened.app, "notes");
  await member.api.screens.present(opened.app, lease);
  const { client } = clientFor(
    { ...opened, lease, cookie: member.session, userId: member.userId },
    member.api.screens
  );
  return { member, them, lease, client };
};

describe("live queries under load and loss", { timeout: 180_000 }, () => {
  it("charges the reads a burst of commits causes to the person's budget, however many queries they follow", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const writer = await memberOf(opened);
    // A second tab of the owner's: each follows up to its bound.
    const { core } = await openRpc(opened.cookie);
    const otherTab = core.authenticate().screens;
    await otherTab.present(opened.app, opened.lease);
    const followers = Array.from({ length: 150 }, () => pageFollower());
    for (let batch = 0; batch < followers.length / 15; batch += 1) {
      // Following counts as a request: fifteen a moment.
      // oxlint-disable-next-line no-await-in-loop -- one moment after the other
      await later(batch + 1, async () => {
        await Promise.all(
          followers
            .slice(batch * 15, batch * 15 + 15)
            .map(async (follower, at) => {
              const index = batch * 15 + at;
              const screens = index < 100 ? opened.screens : otherTab;
              await screens.watchQuery(
                opened.app,
                opened.lease,
                requestOf(api.list, { pagination: { pageSize: index + 1 } }),
                follower.callback
              );
            })
        );
      });
    }
    await eventually(() => {
      expect(
        followers.every(({ received }) => received.length > 0)
      ).toBeTruthy();
    });
    const before = followers.reduce(
      (sum, { received }) => sum + received.length,
      0
    );

    // Another person's commits to the table every one of them read.
    const started = Date.now();
    for (let note = 1; note <= 12; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after the other
      await writer.client.mutation(api.create, { title: `Note ${note}` });
      // oxlint-disable-next-line no-await-in-loop -- spread over a few seconds
      await scheduler.wait(400);
    }
    await scheduler.wait(2000);
    const seconds = (Date.now() - started) / 1000;
    const reads =
      followers.reduce((sum, { received }) => sum + received.length, 0) -
      before;

    const { liveReads, concurrentReads } = querySubscriptionLimits;
    const bound =
      liveReads.burst + (liveReads.perMinute / 60) * seconds + concurrentReads;
    expect({ withinBudget: reads <= bound, read: reads > 0 }).toStrictEqual({
      withinBudget: true,
      read: true,
    });
  });

  it("follows again later when the store holds all the watches it may, instead of giving up", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    const storeId = storeIdSchema.parse(opened.release.store?.storeId);
    const others = Math.ceil(
      storeMaxWatches / querySubscriptionLimits.perPerson
    );
    const held: string[] = [];
    for (let person = 0; person < others; person += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one person's at a time
      const ids = await Promise.all(
        Array.from(
          { length: querySubscriptionLimits.perPerson },
          async () =>
            await store.watch(storeId, `other-${person}`, {}, () => {
              // Another screen, still there.
            })
        )
      );
      held.push(...ids.map(({ id }) => id));
    }
    const { client } = clientFor(opened);
    const list = reading(client, api.list, { pagination: {} });
    await scheduler.wait(3000);
    expect(list.now()).toStrictEqual({ value: undefined, error: undefined });

    // Some of the others stop following: this screen gets its turn.
    await Promise.all(
      held.slice(0, 10).map(async (id) => {
        await store.unwatch(id);
      })
    );

    await vi.waitFor(
      () => {
        expect(shown(list.now())).toStrictEqual([]);
      },
      { timeout: 60_000, interval: 100 }
    );
  });

  it("gives a later reader a fresh read, not a result kept from before a write", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    await clientFor(opened).client.mutation(api.create, { title: "Original" });
    const request = requestOf(api.list, { pagination: {} });
    const first = pageFollower();
    await opened.screens.watchQuery(
      opened.app,
      opened.lease,
      request,
      first.callback
    );
    await eventually(() => {
      expect(titlesOf(first.received.at(-1))).toStrictEqual(["Original"]);
    });

    await silentlyRetitle(opened, "Changed since");
    const joiner = pageFollower();
    await opened.screens.watchQuery(
      opened.app,
      opened.lease,
      request,
      joiner.callback
    );

    await eventually(() => {
      expect(titlesOf(joiner.received[0])).toStrictEqual(["Changed since"]);
    });
  });

  it("finds a write the store never told of by checking its watch now and then", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    await clientFor(opened).client.mutation(api.create, { title: "Original" });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      const follower = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(api.list, { pagination: {} }),
        follower.callback
      );
      await eventually(() => {
        expect(titlesOf(follower.received.at(-1))).toStrictEqual(["Original"]);
      });

      await silentlyRetitle(opened, "Found later");
      await vi.advanceTimersByTimeAsync(querySubscriptionLimits.livenessMs);

      await eventually(() => {
        expect(titlesOf(follower.received.at(-1))).toStrictEqual([
          "Found later",
        ]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing a page was owed once a refusal ended its subscription", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { them, lease, member } = await memberOf(opened);
    const received: Push[] = [];
    const stalled = {
      first: Promise.withResolvers<null>(),
      refusal: Promise.withResolvers<null>(),
    };
    // The page doesn't take its first push, nor the refusal, until the
    // test lets it: what core held for it meanwhile must not go out after.
    // Core waits for what a page's callback answers: that is the point.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await stalled.first.promise;
      } else if (!read.result.ok) {
        await stalled.refusal.promise;
      }
    };
    await member.api.screens.watchQuery(
      opened.app,
      lease,
      requestOf(api.list, { pagination: {} }),
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    const owner = clientFor(opened).client;
    // A read the page owes, waiting behind the first.
    await owner.mutation(api.create, { title: "Elsewhere" });
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.remove(opened.app, them);
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Again" });
          expect(received.some(({ result }) => !result.ok)).toBeTruthy();
        },
        { timeout: 10_000, interval: 250 }
      );
    });
    stalled.first.resolve(null);
    await scheduler.wait(1500);
    stalled.refusal.resolve(null);
    await scheduler.wait(500);

    expect(
      received.map(({ revision, result }) => ({ revision, ok: result.ok }))
    ).toStrictEqual([
      { revision: 1, ok: true },
      { revision: received[1]?.revision, ok: false },
    ]);
  });

  it("checks a subscription against the following frame's own lease", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // The connection presented an approved build's lease; this frame's is
    // one core never signed.
    await expect(
      outcome(
        opened.screens.watchQuery(
          opened.app,
          "not-a-lease-core-signed",
          requestOf(api.list, { pagination: {} }),
          pageFollower().callback
        )
      )
    ).resolves.toBe("screen.unreviewed");
  });

  it("backs off following a query that core lets go of after every push", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const page = pageTransport(opened, opened.screens);
    let follows = 0;
    // Core lets go of each subscription right after its first push.
    const client = new GraspClient({
      call: page.call,
      watch: async (request, onSnapshot, onLost) => {
        follows += 1;
        const handle = await page.watch(
          request,
          (push) => {
            onSnapshot(push);
            onLost();
          },
          () => {
            // Told already.
          }
        );
        return handle;
      },
    });
    const list = reading(client, api.list, { pagination: {} });
    await scheduler.wait(6000);
    list.stop();

    expect(follows).toBeLessThanOrEqual(5);
  });
});

describe("live queries: what goes out, and when", { timeout: 180_000 }, () => {
  it("checks access again before a result that waited goes out, with no write to set it off", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { them, lease, member } = await memberOf(opened);
    const received: Push[] = [];
    const first = Promise.withResolvers<null>();
    // The page holds its first push back while a newer result waits.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await first.promise;
      }
    };
    await member.api.screens.watchQuery(
      opened.app,
      lease,
      requestOf(api.list, { pagination: {} }),
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    await clientFor(opened).client.mutation(api.create, { title: "Theirs" });
    // Room for the read that commit causes: its result waits behind the first.
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.remove(opened.app, them);
    await pastAccessRecheck(async () => {
      first.resolve(null);
      await eventually(() => {
        expect(received.length).toBeGreaterThan(1);
      });
    });

    expect(received.slice(1).map(({ result }) => result.ok)).toStrictEqual([
      false,
    ]);
  });

  it("reads again when the store told of a write before its watch was in place", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    const storeId = storeIdSchema.parse(opened.release.store?.storeId);
    // The owner's screens gone without a word, at the person's bound: the
    // next watch waits while the store asks them whether they're there.
    const asked = Promise.withResolvers<null>();
    await Promise.all(
      Array.from(
        { length: querySubscriptionLimits.perPerson },
        async () =>
          await store.watch(
            storeId,
            opened.builder.userId,
            {},
            // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- a dead screen never answers
            async (tables: string[]) => {
              if (tables.length === 0) {
                asked.resolve(null);
              }
              await Promise.withResolvers<never>().promise;
            }
          )
      )
    );
    const list = reading(clientFor(opened).client, api.list, {
      pagination: {},
    });
    // The query is read, and its watch waits on the sweep: a write now
    // is one the store tells the watch of the moment it is in place,
    // before core heard its ID.
    await asked.promise;
    await clientFor(opened).client.mutation(api.create, {
      title: "Landed meanwhile",
    });
    // With no alarm set, the store sets one before it answers the watch,
    // so its word of the write reaches core first.
    await runInDurableObject(store, async (_store, state) => {
      await state.storage.deleteAlarm();
    });

    await vi.waitFor(
      () => {
        expect(shown(list.now())).toStrictEqual(["Landed meanwhile"]);
      },
      { timeout: 15_000, interval: 100 }
    );
  });

  it("keeps reading other queries while pages hold refusals back", async () => {
    const opened = await openedApp();
    const other = await openedApp();
    const api = apiOf(opened.release);
    const otherApi = apiOf(other.release);
    const { them, lease, member } = await memberOf(opened);
    await other.builder.api.apps.members.add(other.app, {
      ...them,
      role: "user",
    });
    const { lease: otherLease } = await member.api.screens.open(
      other.app,
      "notes"
    );
    const refusals: Push[] = [];
    // A page that never takes the last result of what it follows.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const holding: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      if (!read.result.ok) {
        refusals.push(read);
        await Promise.withResolvers<never>().promise;
      }
    };
    for (let size = 1; size <= 4; size += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await member.api.screens.watchQuery(
        opened.app,
        lease,
        requestOf(api.list, { pagination: { pageSize: size } }),
        holding
      );
    }
    await scheduler.wait(1000);
    await opened.builder.api.apps.members.remove(opened.app, them);
    const owner = clientFor(opened).client;
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Again" });
          expect(refusals).toHaveLength(4);
        },
        { timeout: 15_000, interval: 300 }
      );
    });

    const elsewhere = pageFollower();
    await member.api.screens.watchQuery(
      other.app,
      otherLease,
      requestOf(otherApi.list, { pagination: {} }),
      elsewhere.callback
    );
    await eventually(() => {
      expect(titlesOf(elsewhere.received[0])).toStrictEqual([]);
    });
  });

  it("reads afresh for a page that fell behind, rather than keep its result while it catches up", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    // Two notes near a body's bound: a list of them near an answer's.
    for (const title of ["One", "Two"]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title, body: "x".repeat(100_000) });
    }
    const pushes: Push[][] = [[], []];
    const first = Promise.withResolvers<null>();
    const followerOf = (index: number): ((push: unknown) => void) => {
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const callback: (push: unknown) => void = async (push) => {
        const read = pushSchema.parse(push);
        pushes[index]?.push(read);
        if (read.revision === 1) {
          await first.promise;
        }
      };
      return callback;
    };
    const followers = [followerOf(0), followerOf(1)];
    for (const [index, callback] of followers.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(api.list, { pagination: { pageSize: 10 + index } }),
        callback
      );
    }
    await eventually(() => {
      expect(pushes.map((list) => list.length)).toStrictEqual([1, 1]);
    });
    // A write both read again: past what the page may have waiting.
    await client.mutation(api.create, { title: "Three" });
    await scheduler.wait(1500);
    await silentlyRetitle(opened, "Since then");
    first.resolve(null);

    await eventually(() => {
      for (const list of pushes) {
        expect(titlesOf(list.at(-1))).toStrictEqual([
          "Since then",
          "Since then",
          "Since then",
        ]);
      }
    });
  });
});

/**
 * The Notes App with a table only its builders read and write
 * (`secrets`), and its query and mutation.
 */
const withSecrets = (): Record<string, string> => {
  const schema = files["schema.ts"] ?? "";
  const operations = files["operations/notes.ts"] ?? "";
  const app = files["app.ts"] ?? "";
  return {
    ...files,
    "schema.ts": schema.replace(
      "export default defineSchema({",
      "export default defineSchema({\n  secrets: defineTable({ text: v.string() }),"
    ),
    "operations/notes.ts": `${operations}
export const secrets = query({
  args: {},
  returns: v.array(doc("secrets")),
  handler: async (ctx) => await ctx.db.query("secrets").take(10),
});

export const tell = mutation({
  args: { text: v.string() },
  returns: v.id("secrets"),
  handler: async (ctx, args) => await ctx.db.insert("secrets", args),
});
`,
    "app.ts": app
      .replace(
        "import { big, create, echo, get, list, remove, stamp, update }",
        "import { big, create, echo, get, list, remove, secrets, stamp, tell, update }"
      )
      .replace(
        'access: { tables: { notes: { read: "owner", write: "owner" } } }',
        'access: { tables: { notes: { read: "owner", write: "owner" }, secrets: { read: "appBuilders", write: "appBuilders" } } }'
      )
      .replace(
        "operations: { notes: { list, get, create, update, remove, echo, stamp, big } }",
        "operations: { notes: { list, get, create, update, remove, echo, stamp, big, secrets, tell } }"
      ),
  };
};

describe("live queries and a person's roles", { timeout: 180_000 }, () => {
  it("never pushes what was read for a builder once the person is only a user, even a result that waited", async () => {
    const opened = await openedApp(withSecrets());
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const received: Push[] = [];
    const first = Promise.withResolvers<null>();
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await first.promise;
      }
    };
    await member.api.screens.watchQuery(
      opened.app,
      lease,
      requestOf(secrets, {}),
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    // A builders' record, read for them while they are one: it waits.
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    await pastAccessRecheck(async () => {
      first.resolve(null);
      await eventually(() => {
        expect(received.length).toBeGreaterThan(1);
      });
    });
    await scheduler.wait(500);

    expect(
      received.some(({ result }) =>
        JSON.stringify(result).includes("Builders only")
      )
    ).toBeFalsy();
  });
});

describe(
  "live queries and a failure to try again",
  { timeout: 120_000 },
  () => {
    it("follows again after a read that failed before it read anything, rather than push it as final", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      // A core where no sandbox bounds App code: every read is refused as
      // unavailable, to try again, before it reads the store.
      const { core } = await openRpc(opened.cookie, {
        coreEnv: {
          ...env,
          RUNTIME_PROFILE: "workerd",
          SANDBOX_HOST: undefined,
          SANDBOX_IN_PROCESS: undefined,
        },
      });
      const follower = pageFollower();
      await core
        .authenticate()
        .screens.watchQuery(
          opened.app,
          opened.lease,
          requestOf(api.list, { pagination: {} }),
          follower.callback
        );

      await eventually(() => {
        expect(follower.state.released).toBeTruthy();
      });
      expect(follower.received).toStrictEqual([]);
    });
  }
);

/**
 * Counts the store's reads of a page of `pageSize` records of the opened
 * App's store from now on, as its object answers them.
 */
const countPageReads = async (opened: Opened, pageSize: number) => {
  const storeId = opened.release.store?.storeId;
  const counted = { reads: 0 };
  let undo: (() => void) | undefined;
  const pageOfSize = z.object({
    kind: z.literal("query"),
    query: z.object({
      terminal: z.object({
        kind: z.literal("paginate"),
        pageSize: z.literal(pageSize),
      }),
    }),
  });
  await runInDurableObject(storeObjectOf(opened), (instance) => {
    // SAFETY: a store's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as {
      read: (...args: unknown[]) => Promise<string>;
    };
    const original: unknown = Reflect.get(methods, "read");
    if (typeof original !== "function") {
      throw new TypeError("A store's object reads");
    }
    methods.read = async function read(
      this: unknown,
      ...args: unknown[]
    ): Promise<string> {
      if (args[0] === storeId && pageOfSize.safeParse(args[2]).success) {
        counted.reads += 1;
      }
      const answer: unknown = await Reflect.apply(original, this, args);
      return String(answer);
    };
    undo = () => {
      Reflect.set(methods, "read", original);
    };
  });
  return {
    count: () => counted.reads,
    restore: () => {
      undo?.();
    },
  };
};

describe(
  "live queries and the room a page leaves",
  { timeout: 120_000 },
  () => {
    it("reads a query held back by what other subscriptions waited on once those are released", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      // Two notes near a body's bound: a list of them near an answer's.
      for (const title of ["One", "Two"]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await client.mutation(api.create, { title, body: "x".repeat(100_000) });
      }
      const held = Promise.withResolvers<null>();
      // A page that holds back the first push of each of two queries.
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const holding: (push: unknown) => void = async () => {
        await held.promise;
      };
      const subscriptions = [];
      for (const pageSize of [10, 11]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        const subscription = await opened.screens.watchQuery(
          opened.app,
          opened.lease,
          requestOf(api.list, { pagination: { pageSize } }),
          holding
        );
        subscriptions.push(subscription);
      }
      await scheduler.wait(1500);
      // A third: no room left for its first result.
      const third = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(api.list, { pagination: { pageSize: 12 } }),
        third.callback
      );
      await scheduler.wait(1500);
      expect(third.received).toStrictEqual([]);

      // The two are released, and the pushes they held finish after.
      await Promise.all(
        subscriptions.map(async (subscription) => {
          await subscription.release();
        })
      );
      held.resolve(null);

      await eventually(() => {
        expect(titlesOf(third.received[0])).toStrictEqual(["Two", "One"]);
      });
    });

    it("reads a query whose result found no room again only once there is room for it", async () => {
      const opened = await openedApp(withSecrets());
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      for (const title of ["One", "Two"]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await client.mutation(api.create, { title, body: "x".repeat(100_000) });
      }
      const held = Promise.withResolvers<null>();
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const holding: (push: unknown) => void = async () => {
        await held.promise;
      };
      for (const pageSize of [10, 11]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await opened.screens.watchQuery(
          opened.app,
          opened.lease,
          requestOf(api.list, { pagination: { pageSize } }),
          holding
        );
      }
      await scheduler.wait(1500);
      // A third list finds no room; a small query of another table is
      // taken at once.
      const third = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(api.list, { pagination: { pageSize: 12 } }),
        third.callback
      );
      const secrets = referenceTo<Record<never, never>, unknown, "query">(
        opened.release,
        "notes.secrets"
      );
      const tell = referenceTo<{ text: string }, unknown, "mutation">(
        opened.release,
        "notes.tell"
      );
      const small = pageFollower();
      await opened.screens.watchQuery(
        opened.app,
        opened.lease,
        requestOf(secrets, {}),
        small.callback
      );
      await scheduler.wait(1500);

      // Each small push the page takes leaves no more room for the third.
      const reads = await countPageReads(opened, 12);
      try {
        for (let told = 1; told <= 5; told += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          await client.mutation(tell, { text: `Told ${told}` });
          // oxlint-disable-next-line no-await-in-loop -- see above
          await eventually(() => {
            expect(small.received.length).toBeGreaterThan(told);
          });
        }
        expect({
          third: third.received,
          readsWithoutRoom: reads.count(),
        }).toStrictEqual({ third: [], readsWithoutRoom: 0 });
      } finally {
        reads.restore();
      }
      held.resolve(null);
    });
  }
);

// Revocation (spec 11.4): when a write takes a person's role in an App
// away, their open screens are cleared without waiting for anything to
// commit to what they read, on every tab, and nothing more reaches them;
// anyone whose access holds keeps their screen, whatever the event says.

/**
 * How long a screen may take to be cleared once access is gone: shorter
 * than the window a connection's session reading holds, so what clears it
 * is the event, never that reading running out.
 */
const deliveryWait = { timeout: sessionRecheckMs - 1000, interval: 50 };

/** A raw subscription to the notes list over `screens`, once its first result arrived. */
const followedList = async (
  opened: Opened,
  screens: Screens,
  lease: string
) => {
  const follower = pageFollower();
  await screens.watchQuery(
    opened.app,
    lease,
    requestOf(apiOf(opened.release).list, { pagination: {} }),
    follower.callback
  );
  await eventually(() => {
    expect(follower.received.at(-1)?.result.ok).toBeTruthy();
  });
  return follower;
};

type Follower = Awaited<ReturnType<typeof followedList>>;

/** Statements that read whom an App is shared with. */
const sharedWithQueries = /from "app_members"/u;

/** The look at an App by its ID (apps.ts `findApp`). */
const appLookup = /^select "id", "name", "description"/u;

/** The look at which Apps someone reaches (members.ts). */
const appsLookup = /^select "id" from "apps"/u;

/**
 * Core's database for a connection of its own, which fails the
 * statements `failing` matches once `fail` is called, as D1 does when it
 * is away for a moment.
 */
const flakyDb = (failing: RegExp) => {
  const state = { failing: false };
  const db = new Proxy(env.DB, {
    get: (target, property): unknown => {
      if (property === "prepare") {
        return (query: string) => {
          if (state.failing && failing.test(query)) {
            throw new Error("D1 is away for a moment.");
          }
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
  return {
    env: { ...env, DB: db },
    fail: () => {
      state.failing = true;
    },
  };
};

/**
 * The App hosts' namespace as a connection that can't reach them to tell
 * of a revocation sees it: every `accessRevoked` fails, anything else
 * goes through.
 */
const unreachableRevocations = (namespace: Env["APPS"]): Env["APPS"] =>
  new Proxy(namespace, {
    get: (target, property): unknown => {
      if (property === "getByName") {
        return (name: string) =>
          new Proxy(target.getByName(name), {
            get: (stub, method): unknown => {
              if (method === "accessRevoked") {
                return async () => {
                  await Promise.resolve();
                  throw new Error("The App's host can't be reached.");
                };
              }
              const value: unknown = Reflect.get(stub, method);
              if (typeof value !== "function") {
                return value;
              }
              // A stub's method answers any property as another method,
              // `bind` included: called through, never bound.
              return (...args: unknown[]): unknown =>
                Reflect.apply(value, stub, args);
            },
          });
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });

/** A cleared screen: its last push a refusal, and core let go of it. */
const refusedAndLetGo = { last: "app.not_found", released: true };

/**
 * What `follower` was last sent once core let go of it, which it must
 * within `deliveryWait`.
 */
const whenLetGo = async (follower: Follower) => {
  await vi.waitFor(() => {
    expect(follower.state.released).toBeTruthy();
  }, deliveryWait);
  return {
    last: titlesOf(follower.received.at(-1)),
    released: follower.state.released,
  };
};

/** How long `slowToFollow` holds each connection the App's host takes on. */
const followDelayMs = 2000;

/** Undoes nothing. */
const nothingToUndo = (): void => {
  // Nothing done yet.
};

/**
 * Has the opened App's host take each connection on as followers of its
 * revocations only `followDelayMs` late, as a busy host would. Answers
 * how to undo it.
 */
const slowToFollow = async (opened: Opened) => {
  let undo = nothingToUndo;
  await runInDurableObject(appHost(env, opened.app), (instance) => {
    // SAFETY: an App's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const original = methods.followAccess;
    if (original === undefined) {
      throw new Error("An App's object follows access");
    }
    methods.followAccess = async function followAccess(this: unknown, ...args) {
      await scheduler.wait(followDelayMs);
      return await original.apply(this, args);
    };
    undo = () => {
      methods.followAccess = original;
    };
  });
  return undo;
};

/**
 * Has the opened App's host let go of the first connection it takes on
 * as a follower of its revocations right away, as a host that restarted
 * would, and take the next one on only `followDelayMs` late. Answers how
 * to undo it.
 */
const lettingGoEarly = async (opened: Opened) => {
  let undo = nothingToUndo;
  await runInDurableObject(appHost(env, opened.app), (instance) => {
    // SAFETY: an App's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const original = methods.followAccess;
    const letGo = methods.unfollowAccess;
    if (original === undefined || letGo === undefined) {
      throw new Error("An App's object follows access");
    }
    let calls = 0;
    methods.followAccess = async function followAccess(this: unknown, ...args) {
      calls += 1;
      if (calls > 1) {
        await scheduler.wait(followDelayMs);
        return await original.apply(this, args);
      }
      const id = await original.apply(this, args);
      await Reflect.apply(letGo, this, [id]);
      return id;
    };
    undo = () => {
      methods.followAccess = original;
    };
  });
  return undo;
};

/**
 * Counts the opened App's store's reads of a page of `pageSize` records
 * from now on, holding the first until `release`.
 */
const holdPageReads = async (opened: Opened, pageSize: number) => {
  const storeId = opened.release.store?.storeId;
  const counted = { reads: 0 };
  const held = Promise.withResolvers<null>();
  let undo = nothingToUndo;
  const pageOfSize = z.object({
    kind: z.literal("query"),
    query: z.object({
      terminal: z.object({
        kind: z.literal("paginate"),
        pageSize: z.literal(pageSize),
      }),
    }),
  });
  await runInDurableObject(storeObjectOf(opened), (instance) => {
    // SAFETY: a store's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as {
      read: (...args: unknown[]) => Promise<string>;
    };
    const original: unknown = Reflect.get(methods, "read");
    if (typeof original !== "function") {
      throw new TypeError("A store's object reads");
    }
    methods.read = async function read(
      this: unknown,
      ...args: unknown[]
    ): Promise<string> {
      if (args[0] === storeId && pageOfSize.safeParse(args[2]).success) {
        counted.reads += 1;
        if (counted.reads === 1) {
          await held.promise;
        }
      }
      const answer: unknown = await Reflect.apply(original, this, args);
      return String(answer);
    };
    undo = () => {
      Reflect.set(methods, "read", original);
    };
  });
  return {
    count: () => counted.reads,
    release: () => {
      held.resolve(null);
    },
    restore: () => {
      held.resolve(null);
      undo();
    },
  };
};

/** What reaches `follower` once someone commits to what it read. */
const afterACommit = async (opened: Opened, follower: Follower) => {
  const before = follower.received.length;
  await clientFor(opened).client.mutation(apiOf(opened.release).create, {
    title: "Committed after",
  });
  await scheduler.wait(1500);
  return follower.received.slice(before);
};

describe("live queries when access is revoked", { timeout: 180_000 }, () => {
  it("clears a screen as soon as the person is unshared, with no commit after, and sends nothing more", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
    await expect(afterACommit(opened, follower)).resolves.toStrictEqual([]);
  });

  it("clears the screen of someone who leaves the team the App is shared with", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    await admin.api.apps.members.add(opened.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const follower = await followedList(opened, member.api.screens, lease);

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: member.userId,
    });

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of someone whose team, the App's way to them, is deleted", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    await admin.api.apps.members.add(opened.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const follower = await followedList(opened, member.api.screens, lease);
    // The organization keeps a team: this one is never its last.
    await newTeam(admin, []);

    const removed = await callAuth("/organization/remove-team", admin.session, {
      teamId: team,
    });
    expect(removed.status).toBe(200);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of someone the App was shared with directly, once leaving a team leaves them unable to read what it read", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    const { id: collection } = await admin.api.knowledge.createCollection({
      name: `HR ${unique()}`,
      access: "teams",
      teams: [team],
      sensitive: false,
    });
    await requestGranted(
      idp,
      opened.builder,
      readCollection(
        { type: "app", appId: opened.app },
        collection,
        `HR_${unique().toUpperCase()}`
      )
    );
    // Shared with them as a person, never with the team.
    await opened.builder.api.apps.members.add(opened.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const follower = await followedList(opened, member.api.screens, lease);

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: member.userId,
    });

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears an admin's screen once they are demoted out of the App, on a session read just before", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    await demoted.api.screens.present(opened.app, lease);
    const follower = await followedList(opened, demoted.api.screens, lease);

    await admin.api.members.setRole(demoted.userId, "user");

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("keeps the screens of everyone whose access holds, when others of the App lose theirs", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const leaving = await personApi("user");
    const team = await newTeam(admin, [leaving]);
    const unshared = { type: "team", id: team } as const;
    await admin.api.apps.members.add(opened.app, { ...unshared, role: "user" });
    const { lease } = await leaving.api.screens.open(opened.app, "notes");
    await leaving.api.screens.present(opened.app, lease);
    const theirs = await followedList(opened, leaving.api.screens, lease);
    const staying = await memberOf(opened);
    const kept = await followedList(
      opened,
      staying.member.api.screens,
      staying.lease
    );

    // Everyone the App's host knows of looks again.
    await admin.api.apps.members.remove(opened.app, unshared);
    await expect(whenLetGo(theirs)).resolves.toStrictEqual(refusedAndLetGo);
    await staying.client.mutation(apiOf(opened.release).create, {
      title: "Still mine",
    });

    await eventually(() => {
      expect(titlesOf(kept.received.at(-1))).toStrictEqual(["Still mine"]);
    });
    expect({
      released: kept.state.released,
      refused: kept.received.some(({ result }) => !result.ok),
    }).toStrictEqual({ released: false, refused: false });
  });

  it("changes nothing for someone whose access holds, whoever says it was revoked", async () => {
    const opened = await openedApp();
    const { lease, member, client } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);

    await appHost(env, opened.app).accessRevoked([member.userId]);
    await appHost(env, opened.app).accessRevoked(null);
    await scheduler.wait(1500);
    await client.mutation(apiOf(opened.release).create, { title: "Mine" });

    await eventually(() => {
      expect(titlesOf(follower.received.at(-1))).toStrictEqual(["Mine"]);
    });
    expect({
      released: follower.state.released,
      refused: follower.received.some(({ result }) => !result.ok),
    }).toStrictEqual({ released: false, refused: false });
  });

  it("clears every tab of the person, each on its own connection", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const { core } = await openRpc(member.session);
    const otherTab = core.authenticate().screens;
    await otherTab.present(opened.app, lease);
    const first = await followedList(opened, member.api.screens, lease);
    const second = await followedList(opened, otherTab, lease);

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(first)).resolves.toStrictEqual(refusedAndLetGo);
    await expect(whenLetGo(second)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears what a frame of the tab follows through its own handle", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const frame = await member.api.screens.frame(opened.app, lease);
    const follower = pageFollower();
    await frame.watchQuery(
      requestOf(apiOf(opened.release).list, { pagination: {} }),
      follower.callback
    );
    await eventually(() => {
      expect(follower.received.at(-1)?.result.ok).toBeTruthy();
    });

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("never shows a query followed right after the revocation, on a session read before it", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    // A tab that reads the session now, and follows nothing of the App yet.
    const { core } = await openRpc(demoted.session);
    const tab = core.authenticate().screens;
    await tab.present(opened.app, lease);

    await admin.api.members.setRole(demoted.userId, "user");
    // The App's host is slow to take the tab on: the event went out
    // before, and the tab's reads must wait for it either way.
    const undo = await slowToFollow(opened);
    try {
      const follower = pageFollower();
      await tab.watchQuery(
        opened.app,
        lease,
        requestOf(apiOf(opened.release).list, { pagination: {} }),
        follower.callback
      );

      await vi.waitFor(
        () => {
          expect(follower.state.released).toBeTruthy();
        },
        { ...deliveryWait, timeout: deliveryWait.timeout + followDelayMs }
      );
      expect(follower.received.map(({ result }) => result.ok)).toStrictEqual([
        false,
      ]);
    } finally {
      undo();
    }
  });

  it("follows again once the App's host restarted, so a revocation after still clears the screen", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    await demoted.api.screens.present(opened.app, lease);
    const follower = await followedList(opened, demoted.api.screens, lease);
    await runInDurableObject(appHost(env, opened.app), (_app, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    // Once the connection follows the new host: the event below must reach
    // it there. (Telling it, while its access holds, changes nothing.)
    await vi.waitFor(
      async () => {
        await expect(
          appHost(env, opened.app).accessRevoked([demoted.userId])
        ).resolves.toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 }
    );

    // A demotion tells the host and restarts nothing.
    await admin.api.members.setRole(demoted.userId, "user");

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of someone removed from the organization", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const { lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);

    await admin.api.members.remove(member.userId);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("clears what a query kept while it waits to follow again, once the person is only a user", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const page = pageTransport(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    );
    const isSecrets = (request: string): boolean =>
      z
        .object({ reference: z.object({ contractId: z.string() }) })
        .parse(JSON.parse(request)).reference.contractId === secrets.contractId;
    // The secrets are followed once, then lost after their first push, and
    // followed again only once the test is over: meanwhile the query
    // waits to follow again, showing what it kept.
    const held = Promise.withResolvers<null>();
    let secretsFollows = 0;
    const client = new GraspClient({
      call: page.call,
      watch: async (request, onSnapshot, onLost) => {
        if (!isSecrets(request)) {
          return await page.watch(request, onSnapshot, onLost);
        }
        secretsFollows += 1;
        if (secretsFollows > 1) {
          await held.promise;
          return await page.watch(request, onSnapshot, onLost);
        }
        const handle: { release: (() => void) | undefined } = {
          release: undefined,
        };
        let pushed = false;
        const followed = await page.watch(
          request,
          (push) => {
            onSnapshot(push);
            if (!pushed) {
              pushed = true;
              setTimeout(() => {
                handle.release?.();
                onLost();
              }, 100);
            }
          },
          () => {
            // Told by the test.
          }
        );
        handle.release = followed.release;
        return followed;
      },
    });
    const waiting = reading(client, secrets, {});
    const followed = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect({
        secrets: JSON.stringify(waiting.now().value).includes("Builders only"),
        lost: secretsFollows > 1,
        list: shown(followed.now()),
      }).toStrictEqual({ secrets: true, lost: true, list: [] });
    });

    try {
      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });

      await vi.waitFor(() => {
        expect(followed.now().error?.code).toBe("screen.access_changed");
      }, deliveryWait);
      expect(waiting.now().value).toBeUndefined();
    } finally {
      held.resolve(null);
    }
  });

  it("refuses as a failure to try again, not a lost role, when the role can't be read for a moment", async () => {
    const opened = await openedApp();
    const { lease, member } = await memberOf(opened);
    const flaky = flakyDb(sharedWithQueries);
    const { core } = await openRpc(member.session, { coreEnv: flaky.env });
    const tab = core.authenticate().screens;
    await tab.present(opened.app, lease);
    const follower = await followedList(opened, tab, lease);

    flaky.fail();
    await appHost(env, opened.app).accessRevoked([member.userId]);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "internal.unexpected",
      released: true,
    });
  });

  it("reads one App's query once, though another App's access is looked at again while it is read", async () => {
    const opened = await openedApp();
    const other = await openedApp();
    const { lease, member } = await memberOf(opened);
    await other.builder.api.apps.members.add(other.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const { lease: otherLease } = await member.api.screens.open(
      other.app,
      "notes"
    );
    await member.api.screens.present(other.app, otherLease);
    await followedList(other, member.api.screens, otherLease);
    const pageSize = 7;
    const reads = await holdPageReads(opened, pageSize);
    try {
      const follower = pageFollower();
      await member.api.screens.watchQuery(
        opened.app,
        lease,
        requestOf(apiOf(opened.release).list, { pagination: { pageSize } }),
        follower.callback
      );
      await eventually(() => {
        expect(reads.count()).toBe(1);
      });

      // While this App's query is read, the other App's host tells the
      // connection to look again: only the other App's queries look.
      await expect(
        appHost(env, other.app).accessRevoked([member.userId])
      ).resolves.toBe(1);
      await scheduler.wait(500);
      reads.release();

      await eventually(() => {
        expect(follower.received.at(-1)?.result.ok).toBeTruthy();
      });
      await scheduler.wait(1000);
      expect({
        reads: reads.count(),
        pushes: follower.received.length,
      }).toStrictEqual({ reads: 1, pushes: 1 });
    } finally {
      reads.restore();
    }
  });

  it("reads nothing of an App until the host that let go of it early takes the connection on again", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    const { core } = await openRpc(demoted.session);
    const tab = core.authenticate().screens;
    await tab.present(opened.app, lease);
    // The host lets go of the connection's first following at once, and
    // takes the next one on only `followDelayMs` later.
    const undo = await lettingGoEarly(opened);
    try {
      const follower = pageFollower();
      await tab.watchQuery(
        opened.app,
        lease,
        requestOf(apiOf(opened.release).list, { pagination: {} }),
        follower.callback
      );
      await scheduler.wait(500);
      // Before the next following: no host tells the connection of this.
      await admin.api.members.setRole(demoted.userId, "user");

      await vi.waitFor(
        () => {
          expect(follower.state.released).toBeTruthy();
        },
        { ...deliveryWait, timeout: deliveryWait.timeout + followDelayMs }
      );
      expect(follower.received.map(({ result }) => result.ok)).toStrictEqual([
        false,
      ]);
    } finally {
      undo();
    }
  });

  it("refuses as a failure to try again, not a lost role, when the App can't be looked up for a moment", async () => {
    const opened = await openedApp();
    const { lease, member } = await memberOf(opened);
    const flaky = flakyDb(appLookup);
    const { core } = await openRpc(member.session, { coreEnv: flaky.env });
    const tab = core.authenticate().screens;
    await tab.present(opened.app, lease);
    const follower = await followedList(opened, tab, lease);

    flaky.fail();
    await appHost(env, opened.app).accessRevoked([member.userId]);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "internal.unexpected",
      released: true,
    });
  });

  it("removes someone from the organization, and lowers a role, even when looking up their Apps fails", async () => {
    const admin = await personApi("admin");
    const removed = await personApi("user");
    const lowered = await personApi("builder");
    const flaky = flakyDb(appsLookup);
    const { core } = await openRpc(admin.session, { coreEnv: flaky.env });
    const session = core.authenticate();
    flaky.fail();

    expect({
      removed: await outcome(session.members.remove(removed.userId)),
      lowered: await outcome(session.members.setRole(lowered.userId, "user")),
    }).toStrictEqual({ removed: "ok", lowered: "ok" });
  });

  it("tells an App's host later, from the cron trigger, when it can't be reached when access drops", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);
    // The builder's own connection, whose word to the App's host that
    // access dropped never arrives.
    const { core } = await openRpc(opened.cookie, {
      coreEnv: { ...env, APPS: unreachableRevocations(env.APPS) },
    });

    await core.authenticate().apps.members.remove(opened.app, them);
    await scheduler.wait(1500);
    const before = follower.state.released;
    await runCron();

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("drops a kept revocation once it is a day old, however many others the cron trigger tells first", async () => {
    const opened = await openedApp();
    const now = Date.now();
    const keep = env.DB.prepare(
      "insert into access_revocations (id, app_id, user_ids, attempts, created_at) values (?, ?, null, ?, ?)"
    );
    const expired = crypto.randomUUID();
    // More than one run tells, none tried yet: each run reaches them
    // before the old one, which was tried once.
    const fresh = Array.from({ length: 101 }, () =>
      keep.bind(crypto.randomUUID(), opened.app, 0, now)
    );
    await env.DB.batch([
      ...fresh,
      keep.bind(expired, opened.app, 1, now - 25 * 60 * 60 * 1000),
    ]);

    await runCron();

    const left = await env.DB.prepare(
      "select id from access_revocations where id = ?"
    )
      .bind(expired)
      .first();
    expect(left).toBeNull();
  });

  it("clears the screen of someone removed who reached the App through a team, even when looking up their Apps fails", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    await admin.api.apps.members.add(opened.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const follower = await followedList(opened, member.api.screens, lease);
    // The admin's own connection, whose look at the Apps someone reaches
    // fails, before the removal and after it.
    const flaky = flakyDb(appsLookup);
    const { core } = await openRpc(admin.session, { coreEnv: flaky.env });
    flaky.fail();

    await core.authenticate().members.remove(member.userId);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("reads again for someone who is now only a user, rather than keep showing what builders read", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const follower = pageFollower();
    await member.api.screens.watchQuery(
      opened.app,
      lease,
      requestOf(secrets, {}),
      follower.callback
    );
    const showsSecret = () =>
      JSON.stringify(follower.received.at(-1)?.result).includes(
        "Builders only"
      );
    await eventually(() => {
      expect(showsSecret()).toBeTruthy();
    });

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });

    await vi.waitFor(() => {
      expect(showsSecret()).toBeFalsy();
    }, deliveryWait);
  });

  it("drops what a screen kept from before the person became only a user, while the query it follows shows nothing yet", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const { client } = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    );
    const kept = reading(client, secrets, {});
    await eventually(() => {
      expect(JSON.stringify(kept.now().value)).toContain("Builders only");
    });
    // No longer shown: the client keeps it for a while.
    kept.stop();
    const pageSize = 9;
    const reads = await holdPageReads(opened, pageSize);
    try {
      // Followed, its first read held: it has shown nothing yet.
      const pending = reading(client, apiOf(opened.release).list, {
        pagination: { pageSize },
      });
      await eventually(() => {
        expect(reads.count()).toBe(1);
      });

      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });

      await vi.waitFor(() => {
        expect(pending.now().error?.code).toBe("screen.access_changed");
      }, deliveryWait);
      expect(kept.now().value).toBeUndefined();
    } finally {
      reads.restore();
    }
  });

  it("shows nothing a screen kept from before the person became only a user, followed or not", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    await member.api.screens.present(opened.app, lease);
    const { client } = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    );
    const followed = reading(client, secrets, {});
    // Read once, then no longer shown: the client keeps it for a while.
    const kept = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect({
        followed: JSON.stringify(followed.now().value).includes(
          "Builders only"
        ),
        kept: shown(kept.now()),
      }).toStrictEqual({ followed: true, kept: [] });
    });
    kept.stop();

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });

    await vi.waitFor(() => {
      expect(followed.now().error?.code).toBe("screen.access_changed");
    }, deliveryWait);
    expect(kept.now()).toMatchObject({ value: undefined });
    // Read again, it is read afresh, under the roles they have now.
    const again = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect(shown(again.now())).toStrictEqual([]);
    });
  });
});
