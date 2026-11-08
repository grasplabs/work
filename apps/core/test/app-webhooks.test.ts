import {
  appWebhookHeaders,
  appWebhookLimits,
  signedTextOf,
} from "@grasp-os/shared/app-webhooks";
import { toHex } from "@grasp-os/shared/encoding";
import { streamRetentionMs } from "@grasp-os/shared/function-limits";
import type { Json } from "@grasp-os/shared/json";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { accessOf, invocationName } from "../src/action-invocation.ts";
import { loadRelease } from "../src/app-releases.ts";
import {
  formKeptMs,
  formSubmissionOf,
  queueFormSent,
} from "../src/app-webhook-queue.ts";
import { drainWebhookDeliveries } from "../src/app-webhooks.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { appDefinition } from "./app-definitions.ts";
import { published } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  webhookReceivedUrl,
  webhookReceiverOrigin,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// A company's webhooks for an App (core's app-webhooks.ts, connect's
// webhooks.ts), from their threat model: a URL reaching inside a network
// or redirecting there; a delivery forged, sent twice or lost; the App's
// data leaving before an admin approved the URL; someone who doesn't
// build the App adding one, or anyone but an admin approving one; a
// delivery nobody can trace.

const idp = mockIdp();

/** Arrays this deep around a string, from an input's own level: 32 in all. */
const deepLevels = 30;

/** The validator of `deepLevels` arrays around a string. */
const deepValidator = (() => {
  let validator = "v.string()";
  for (let level = 0; level < deepLevels; level += 1) {
    validator = `v.array(${validator})`;
  }
  return validator;
})();

const files: Record<string, string> = {
  ...appDefinition({
    name: "Notes",
    tables: {
      notes: {
        fields: { title: "v.string().min(1).max(200)" },
        access: { read: "appMembers", write: "appMembers" },
      },
      blobs: {
        fields: { body: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  }),
  "server/notes.ts": `import { action, mutation, query } from "@server/_generated/server";
import { v } from "@grasp-os/sdk";

export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.db.query("notes").count(),
});

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

const pause = async (ms: number) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

export const write = action({
  args: { title: v.string(), pauseMs: v.number().integer().min(0).default(0) },
  returns: v.string(),
  stream: v.object({ step: v.number() }),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.emit({ step: 1 });
    await pause(args.pauseMs);
    await ctx.runMutation(create, { title: args.title });
    return args.title;
  },
});

export const fill = mutation({
  args: {
    inserts: v.number().integer().min(0).max(10),
    answer: v.number().integer().min(0).max(262_000),
    pad: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    for (let index = 0; index < args.inserts; index += 1) {
      await ctx.db.insert("blobs", { body: "x".repeat(100_000) });
    }
    return "r".repeat(args.answer);
  },
});

export const keepDeep = mutation({
  args: { deep: ${deepValidator} },
  returns: v.id("notes"),
  handler: async (ctx) => await ctx.db.insert("notes", { title: "Deep" }),
});

export const add = action({
  args: { title: v.string(), pauseMs: v.number().integer().min(0).default(0) },
  returns: v.string(),
  uses: [create],
  handler: async (ctx, args) => {
    await pause(args.pauseMs);
    await ctx.runMutation(create, { title: args.title });
    return args.title;
  },
});
`,

  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return <p>Notes</p>;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
};

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** A builder's Notes App, its first version current, left a draft. */
const notesApp = async (builder: Person) => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  return { app: id, version };
};

/**
 * A builder's Notes App, published, and its page open:
 * a page that can send its forms.
 */
const openNotes = async () => {
  const [builder, admin] = await Promise.all([
    personApi("builder"),
    personApi("admin"),
  ]);
  const { app, version } = await notesApp(builder);
  await published(app);
  const { lease } = await builder.api.pages.open(app);
  const release = await loadRelease(env, app, version);
  return { builder, admin, app, lease, release };
};

type Open = Awaited<ReturnType<typeof openNotes>>;

/** Who sends a form: a person, with the page they opened. */
interface Sender {
  builder: Person;
  lease: string;
}

/** The open App's store, which a mutation commits its form to. */
const storeOf = ({ release }: Open) => {
  if (release.store === null) {
    throw new Error("Expected the App to have a store");
  }
  return inJurisdiction(env, env.DATA_STORES).getByName(release.store.storeId);
};

/** What the open App's store still owes others: its outbox, unsettled. */
const owedBy = async (open: Open): Promise<number> =>
  await runInDurableObject(
    storeOf(open),
    (_instance, state) =>
      state.storage.sql
        .exec<{ owed: number }>(
          "SELECT count(*) AS owed FROM sdk_change_outbox WHERE settled_at IS NULL"
        )
        .one().owed
  );

/** How many of the open App's outbox entries still hold a form's values. */
const valuesKeptBy = async (open: Open): Promise<number> =>
  await runInDurableObject(
    storeOf(open),
    (_instance, state) =>
      state.storage.sql
        .exec<{ kept: number }>(
          `SELECT count(*) AS kept FROM sdk_change_outbox
           WHERE kind = 'app.form_sent'
             AND json_type(intent, '$.data.values') NOT IN ('null')`
        )
        .one().kept
  );

/**
 * Has the open App's store hand over what its commits owe, as its alarm
 * does, until it owes nothing: a mutation's form told.
 */
const storeHandsOver = async (open: Open): Promise<void> => {
  await vi.waitFor(
    async () => {
      await runDurableObjectAlarm(storeOf(open));
      await expect(owedBy(open)).resolves.toBe(0);
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** `sent`, without waiting for the store to hand anything over. */
const sentOnly = async (
  { builder, app, lease, release }: Open,
  path: string,
  input: Json,
  key?: string,
  by?: Sender
): Promise<unknown> => {
  const sender = by ?? { builder, lease };
  const response = await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: sender.builder.session,
      [pagePersonHeader]: sender.builder.userId,
      [pageLeaseHeader]: sender.lease,
    },
    body: JSON.stringify({
      reference: { name: path, kind: release.app.operations[path]?.kind },
      input,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    }),
  });
  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  return typeof answer === "object" && answer !== null
    ? Reflect.get(answer, "result")
    : undefined;
};

/**
 * Sends `input` to `path` as the open page does, under `key` if given:
 * as its builder, or as `by` with the page they opened. A mutation's
 * form is handed over by its store before it answers.
 */
const sent = async (
  open: Open,
  path: string,
  input: Json,
  key?: string,
  by?: Sender
): Promise<unknown> => {
  const result = await sentOnly(open, path, input, key, by);
  if (open.release.app.operations[path]?.kind === "mutation") {
    await storeHandsOver(open);
  }
  return result;
};

/**
 * Streams `input` to the streaming action `path` under `key` as the open
 * page does, starting or joining its run (`stream`) or reading it again
 * (`attach`): its result, as the last line says it.
 */
const streamed = async (
  { builder, app, lease, release }: Open,
  what: "stream" | "attach",
  path: string,
  input: Json,
  key: string
): Promise<unknown> => {
  const response = await routed(`${appFunctionPath}/${app}/${what}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: builder.session,
      [pagePersonHeader]: builder.userId,
      [pageLeaseHeader]: lease,
    },
    body: JSON.stringify({
      reference: { name: path, kind: release.app.operations[path]?.kind },
      input,
      idempotencyKey: key,
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const lines = text.trim().split("\n");
  const last: unknown = JSON.parse(lines.at(-1) ?? "null");
  return typeof last === "object" && last !== null
    ? Reflect.get(last, "result")
    : undefined;
};

/** The reference of `path` in the open page's release. */
const referenceOf = ({ release }: Open, path: string) => ({
  name: path,
  kind: release.app.operations[path]?.kind ?? "action",
});

/** The error `result`, a call's as core answers it, carries, if any. */
const errorOf = (result: unknown): unknown =>
  typeof result === "object" && result !== null && "error" in result
    ? result.error
    : undefined;

/** The result the last of `text`'s JSON lines carries, as an invocation ends. */
const resultOfLines = (text: string): unknown => {
  const last: unknown = JSON.parse(text.trim().split("\n").at(-1) ?? "null");
  return typeof last === "object" && last !== null && "result" in last
    ? last.result
    : undefined;
};

/** Whether `result`, a call's as core answers it, says it succeeded. */
const okOf = (result: unknown): boolean =>
  typeof result === "object" &&
  result !== null &&
  "ok" in result &&
  result.ok === true;

/** A receiver URL no other test sends to, with `path` before its own part. */
const receiver = (path = ""): string =>
  `${webhookReceiverOrigin}${path}/${unique()}`;

/** What reached the receiver at `url`, in order. */
interface Received {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The providers Worker, where the webhook receiver is. */
const providers = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

const receivedAt = async (url: string): Promise<Received[]> => {
  const response = await providers().fetch(webhookReceivedUrl);
  const all: Received[] = await response.json();
  return all.filter((call) => call.url === url);
};

/** How many requests reached `url`. */
const countAt = async (url: string): Promise<number> => {
  const calls = await receivedAt(url);
  return calls.length;
};

/** Drains the deliveries until `url` has had `count`, or the wait ends. */
const reachedEventually = async (url: string, count: number) => {
  await vi.waitFor(
    async () => {
      await drainWebhookDeliveries(env);
      await expect(countAt(url)).resolves.toBe(count);
    },
    { timeout: 20_000, interval: 250 }
  );
};

/** A delivery's body, as a receiver reads it. */
const payloadSchema = z.looseObject({
  id: z.string(),
  event: z.string(),
  app: z.string(),
  occurredAt: z.string(),
  version: z.number().optional(),
});

/** The body of each delivery that reached `url`. */
const payloadsAt = async (url: string) => {
  const calls = await receivedAt(url);
  return calls.map(({ body }) => payloadSchema.parse(JSON.parse(body)));
};

/** Whether `call` is signed with `secret` as a receiver checks it. */
const signedWith = async (call: Received, secret: string): Promise<boolean> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const timestamp = Number(call.headers[appWebhookHeaders.timestamp]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedTextOf(timestamp, call.body))
  );
  return (
    call.headers[appWebhookHeaders.signature] ===
    `v1=${toHex(new Uint8Array(mac))}`
  );
};

/** Makes every waiting delivery of webhook `webhook` due now. */
const dueNow = async (webhook: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE app_webhook_deliveries SET delivery_at = NULL WHERE webhook_id = ? AND delivered_at IS NULL"
  )
    .bind(webhook)
    .run();
};

/** The deliveries of webhook `webhook`, as core keeps them. */
const deliveriesOf = async (webhook: string) => {
  const { results } = await env.DB.prepare(
    'SELECT attempts, outcome, delivered_at IS NOT NULL AS settled, "values" IS NOT NULL AS has_values FROM app_webhook_deliveries WHERE webhook_id = ? ORDER BY occurred_at'
  )
    .bind(webhook)
    .all<{
      attempts: number;
      outcome: string | null;
      settled: number;
      has_values: number;
    }>();
  return results;
};

describe("an App's webhooks", { timeout: 120_000 }, () => {
  it("takes only an https URL on the public internet, from the App's builders, never its users or Grasp staff", async () => {
    const [builder, user] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const { app } = await notesApp(builder);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const events = ["published" as const];
    const url = receiver();

    const refused = await Promise.all(
      [
        "http://hooks.acme-receiver.test/x",
        "https://10.0.0.8/x",
        "https://hooks.internal/x",
        "https://localhost/x",
        "https://someone@hooks.acme-receiver.test/x",
        "https://hooks.acme-receiver.test./x",
        "ftp://hooks.acme-receiver.test/x",
      ].map(
        async (bad) =>
          await outcome(
            builder.api.apps.webhooks.add(app, { url: bad, events })
          )
      )
    );
    const noEvents = await outcome(
      builder.api.apps.webhooks.add(app, { url, events: [] })
    );
    const byUser = await outcome(
      user.api.apps.webhooks.add(app, { url, events })
    );
    const byStaff = await outcome(
      staff.apps.webhooks.add(app, { url, events })
    );
    const added = await builder.api.apps.webhooks.add(app, {
      url: `${url}?token=receiver-own-secret`,
      events,
    });
    const more = await Promise.all(
      Array.from(
        { length: 4 },
        async () =>
          await builder.api.apps.webhooks.add(app, { url: receiver(), events })
      )
    );
    const full = await outcome(
      builder.api.apps.webhooks.add(app, { url: receiver(), events })
    );
    const listed = await builder.api.apps.webhooks.list(app);
    const logged = await allEvents();
    const entry = logged.find(
      ({ action, detail }) =>
        action === "app.webhook.added" && detail?.webhook === added.webhook.id
    );

    expect({
      refused,
      noEvents,
      byUser,
      byStaff,
      secret: added.secret.startsWith("gwhsec_"),
      approved: added.webhook.approved,
      more: more.length,
      full,
      listed: listed.length,
      // Listed without the secret, which is shown only the once.
      secretListed: JSON.stringify(listed).includes(added.secret),
      // The URL by its origin only: its query is the receiver's own.
      entry: entry?.detail,
    }).toStrictEqual({
      refused: Array.from({ length: 7 }, () => "webhook.invalid_url"),
      noEvents: "webhook.invalid",
      // A draft's user has no role in it yet: as an App that isn't there.
      byUser: "app.not_found",
      byStaff: "role.forbidden",
      secret: true,
      approved: null,
      more: 4,
      full: "webhook.full",
      listed: 5,
      secretListed: false,
      entry: {
        webhook: added.webhook.id,
        origin: webhookReceiverOrigin,
        events: "published",
      },
    });
  });

  it("is approved for the App's data only by an admin of the workspace, never its builder or Grasp staff", async () => {
    const [builder, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const { app } = await notesApp(builder);
    const { webhook } = await builder.api.apps.webhooks.add(app, {
      url: receiver(),
      events: ["form_sent"],
    });

    const byBuilder = await outcome(
      builder.api.apps.webhooks.approve(app, webhook.id)
    );
    const byStaff = await outcome(staff.apps.webhooks.approve(app, webhook.id));
    const unknown = await outcome(
      admin.api.apps.webhooks.approve(app, crypto.randomUUID())
    );
    const approved = await admin.api.apps.webhooks.approve(app, webhook.id);
    // Approving it again changes and records nothing.
    await admin.api.apps.webhooks.approve(app, webhook.id);
    const logged = await allEvents();

    expect({
      byBuilder,
      byStaff,
      unknown,
      approvedBy: approved.approved?.by,
      entries: logged
        .filter(
          ({ action, detail }) =>
            action === "app.webhook.approved" && detail?.webhook === webhook.id
        )
        .map(({ actor }) => actor),
    }).toStrictEqual({
      byBuilder: "role.forbidden",
      byStaff: "role.forbidden",
      unknown: "webhook.not_found",
      approvedBy: admin.userId,
      entries: [{ type: "person", userId: admin.userId }],
    });
  });

  it("sends a form with IDs only until an admin approves the URL, then with its values, signed, once per submission", async () => {
    const open = await openNotes();
    const url = receiver();
    const { webhook, secret } = await open.builder.api.apps.webhooks.add(
      open.app,
      { url, events: ["form_sent"] }
    );

    await sent(open, "notes.create", { title: "Before" }, "form-1");
    // Sent again under its key: the same submission, told once.
    await sent(open, "notes.create", { title: "Before" }, "form-1");
    // No key: no form's submission to tell.
    await sent(open, "notes.create", { title: "Unkeyed" });
    await drainWebhookDeliveries(env);
    await open.admin.api.apps.webhooks.approve(open.app, webhook.id);
    await sent(open, "notes.create", { title: "After" }, "form-2");
    await sent(open, "notes.add", { title: "By action" }, "form-3");
    await drainWebhookDeliveries(env);
    const calls = await receivedAt(url);
    const payloads = await payloadsAt(url);
    const signed = await Promise.all(
      calls.map(async (call) => await signedWith(call, secret))
    );

    expect({
      payloads: payloads.map(({ id: _id, occurredAt: _at, ...rest }) => rest),
      ids: calls.map(
        (call, index) =>
          call.headers[appWebhookHeaders.id] === payloads[index]?.id
      ),
      events: calls.map((call) => call.headers[appWebhookHeaders.event]),
      signed,
      // Values cleared once delivered.
      kept: await deliveriesOf(webhook.id),
    }).toStrictEqual({
      payloads: [
        { event: "form_sent", app: open.app, submission: "form-1" },
        {
          event: "form_sent",
          app: open.app,
          submission: "form-2",
          operation: "notes.create",
          values: { title: "After" },
        },
        {
          event: "form_sent",
          app: open.app,
          submission: "form-3",
          operation: "notes.add",
          values: { title: "By action" },
        },
      ],
      ids: [true, true, true],
      events: ["form_sent", "form_sent", "form_sent"],
      signed: [true, true, true],
      kept: Array.from({ length: 3 }, () => ({
        attempts: 1,
        outcome: "delivered",
        settled: 1,
        has_values: 0,
      })),
    });
  });

  it("tells the App's publish and a version made current, with the change, and audits each delivery by its origin", async () => {
    const builder = await personApi("builder");
    const { app } = await notesApp(builder);
    const url = receiver();
    const { webhook } = await builder.api.apps.webhooks.add(app, {
      url,
      events: ["published", "changed"],
    });

    await builder.api.apps.publish(app);
    const { version } = await builder.api.apps.files.commit(
      app,
      { ...files, "notes.md": "Second\n" },
      "Second"
    );
    await builder.api.apps.versions.setCurrent(app, version);
    await drainWebhookDeliveries(env);
    const payloads = await payloadsAt(url);
    const logged = await allEvents();

    expect({
      payloads: payloads.map(({ event, version: told }) => ({
        event,
        version: told,
      })),
      calls: logged
        .filter(
          ({ action, detail }) =>
            action === "webhook.call" && detail?.webhook === webhook.id
        )
        .map(({ source, target, detail }) => ({
          source,
          target,
          origin: detail?.origin,
          outcome: detail?.outcome,
          status: detail?.status,
        })),
    }).toStrictEqual({
      payloads: [
        { event: "published", version: 1 },
        { event: "changed", version },
      ],
      calls: Array.from({ length: 2 }, () => ({
        source: "connect",
        target: { type: "app", id: app },
        origin: webhookReceiverOrigin,
        outcome: "delivered",
        status: 200,
      })),
    });
  });

  it("tries a failing receiver again under the same ID, and gives a delivery up after its last try, audited", async () => {
    const builder = await personApi("builder");
    const { app } = await notesApp(builder);
    const flaky = receiver("/fail-1");
    const down = receiver("/status/500");
    const [first, second] = await Promise.all(
      [flaky, down].map(
        async (url) =>
          await builder.api.apps.webhooks.add(app, {
            url,
            events: ["published"],
          })
      )
    );
    if (first === undefined || second === undefined) {
      throw new Error("Expected two webhooks");
    }

    await builder.api.apps.publish(app);
    await drainWebhookDeliveries(env, { maxAttempts: 2 });
    const afterOne = await deliveriesOf(first.webhook.id);
    await Promise.all([dueNow(first.webhook.id), dueNow(second.webhook.id)]);
    await drainWebhookDeliveries(env, { maxAttempts: 2 });
    const flakyCalls = await receivedAt(flaky);
    const logged = await allEvents();

    expect({
      afterOne,
      flaky: await deliveriesOf(first.webhook.id),
      sameId: new Set(
        flakyCalls.map(({ headers }) => headers[appWebhookHeaders.id])
      ).size,
      flakyCalls: flakyCalls.length,
      down: await deliveriesOf(second.webhook.id),
      downCalls: await countAt(down),
      givenUp: logged
        .filter(
          ({ action, detail }) =>
            action === "app.webhook.undeliverable" &&
            detail?.webhook === second.webhook.id
        )
        .map(({ detail }) => ({
          attempts: detail?.attempts,
          outcome: detail?.outcome,
        })),
    }).toStrictEqual({
      // Failed once, waiting for its next try.
      afterOne: [{ attempts: 1, outcome: null, settled: 0, has_values: 0 }],
      flaky: [{ attempts: 2, outcome: "delivered", settled: 1, has_values: 0 }],
      sameId: 1,
      flakyCalls: 2,
      down: [
        { attempts: 2, outcome: "failed:status", settled: 1, has_values: 0 },
      ],
      downCalls: 2,
      givenUp: [{ attempts: 2, outcome: "failed:status" }],
    });
  });

  it("follows no redirect, and sends nothing to a URL connect refuses, whatever core kept", async () => {
    const builder = await personApi("builder");
    const { app } = await notesApp(builder);
    const redirecting = receiver("/redirect");
    const { webhook } = await builder.api.apps.webhooks.add(app, {
      url: redirecting,
      events: ["published"],
    });
    // A URL core would never take, as if it had been kept anyway.
    const inside = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO app_webhooks (id, app_id, url, events, created_by, created_at) VALUES (?, ?, 'https://10.0.0.8/hook', '[\"published\"]', ?, ?)"
    )
      .bind(inside, app, builder.userId, Date.now())
      .run();

    await builder.api.apps.publish(app);
    await drainWebhookDeliveries(env, { maxAttempts: 1 });
    const logged = await allEvents();

    expect({
      redirected: await deliveriesOf(webhook.id),
      reachedOnlyIt: await countAt(redirecting),
      refused: await deliveriesOf(inside),
      refusedCall: logged
        .filter(
          ({ action, detail }) =>
            action === "webhook.call" && detail?.webhook === inside
        )
        .map(({ detail }) => ({
          outcome: detail?.outcome,
          reason: detail?.reason,
          origin: detail?.origin,
        })),
    }).toStrictEqual({
      redirected: [
        { attempts: 1, outcome: "failed:redirect", settled: 1, has_values: 0 },
      ],
      reachedOnlyIt: 1,
      refused: [
        {
          attempts: 1,
          outcome: "refused:ip_literal",
          settled: 1,
          has_values: 0,
        },
      ],
      refusedCall: [
        { outcome: "refused", reason: "ip_literal", origin: undefined },
      ],
    });
  });

  it("is removed with every delivery still waiting, by its builders and admins, never its users", async () => {
    const open = await openNotes();
    const user = await personApi("user");
    await open.builder.api.apps.members.add(open.app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const url = receiver();
    const [kept, removed] = await Promise.all(
      Array.from(
        { length: 2 },
        async () =>
          await open.builder.api.apps.webhooks.add(open.app, {
            url,
            events: ["form_sent"],
          })
      )
    );
    if (kept === undefined || removed === undefined) {
      throw new Error("Expected two webhooks");
    }

    await sent(open, "notes.create", { title: "Waiting" }, "form-w");
    const byUser = await outcome(
      user.api.apps.webhooks.remove(open.app, removed.webhook.id)
    );
    await open.builder.api.apps.webhooks.remove(open.app, removed.webhook.id);
    const again = await outcome(
      open.builder.api.apps.webhooks.remove(open.app, removed.webhook.id)
    );
    await open.admin.api.apps.webhooks.remove(open.app, kept.webhook.id);
    await drainWebhookDeliveries(env);
    const logged = await allEvents();

    expect({
      byUser,
      again,
      waiting: [
        ...(await deliveriesOf(removed.webhook.id)),
        ...(await deliveriesOf(kept.webhook.id)),
      ],
      reached: await countAt(url),
      listed: await open.builder.api.apps.webhooks.list(open.app),
      removals: logged
        .filter(
          ({ action, target }) =>
            action === "app.webhook.removed" && target?.id === open.app
        )
        .map(({ actor }) => actor),
    }).toStrictEqual({
      // The App is published, so its user sees it but builds nothing.
      byUser: "role.forbidden",
      again: "webhook.not_found",
      waiting: [],
      reached: 0,
      listed: [],
      removals: [
        { type: "person", userId: open.builder.userId },
        { type: "person", userId: open.admin.userId },
      ],
    });
  });

  it("keeps apart forms sent under one key by different people, or to different functions", async () => {
    const open = await openNotes();
    const user = await personApi("user");
    await open.builder.api.apps.members.add(open.app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { lease } = await user.api.pages.open(open.app);
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });

    const answers = [
      await sent(open, "notes.create", { title: "Builder" }, "shared"),
      await sent(open, "notes.create", { title: "User" }, "shared", {
        builder: user,
        lease,
      }),
      await sent(open, "notes.add", { title: "Action" }, "shared"),
    ];
    await drainWebhookDeliveries(env);
    const payloads = await payloadsAt(url);

    expect({
      answered: answers.map((answer) => okOf(answer)),
      told: payloads.map(({ event, submission }) => ({ event, submission })),
      apart: new Set(payloads.map(({ id }) => id)).size,
    }).toStrictEqual({
      answered: [true, true, true],
      told: Array.from({ length: 3 }, () => ({
        event: "form_sent",
        submission: "shared",
      })),
      apart: 3,
    });
  });

  it("tells a form only to the webhooks there as it was first sent, its values only if approved by then, however often it is sent again", async () => {
    const open = await openNotes();
    const before = receiver();
    const { webhook: early } = await open.builder.api.apps.webhooks.add(
      open.app,
      { url: before, events: ["form_sent"] }
    );

    // Sent while only an unapproved webhook is there.
    await sent(open, "notes.create", { title: "Mutation" }, "early-m");
    await sent(open, "notes.add", { title: "Action" }, "early-a");
    const later = receiver();
    const { webhook: added } = await open.builder.api.apps.webhooks.add(
      open.app,
      { url: later, events: ["form_sent"] }
    );
    await Promise.all(
      [early, added].map(
        async ({ id }) =>
          await open.admin.api.apps.webhooks.approve(open.app, id)
      )
    );
    // Sent again under their keys, answered from their receipts.
    const again = [
      await sent(open, "notes.create", { title: "Mutation" }, "early-m"),
      await sent(open, "notes.add", { title: "Action" }, "early-a"),
      await sent(open, "notes.create", { title: "Mutation" }, "early-m"),
    ];
    await drainWebhookDeliveries(env);
    const toEarly = await payloadsAt(before);
    const toLater = await countAt(later);
    await sent(open, "notes.create", { title: "Now" }, "late");
    await drainWebhookDeliveries(env);
    const afterNew = await payloadsAt(later);

    expect({
      again: again.map((answer) => okOf(answer)),
      // Told once each, without the values it wasn't approved for then.
      toEarly: toEarly.map(({ submission, values }) => ({
        submission,
        values,
      })),
      toLater,
      afterNew: afterNew.map(({ submission, values }) => ({
        submission,
        values,
      })),
    }).toStrictEqual({
      again: [true, true, true],
      toEarly: [
        { submission: "early-m", values: undefined },
        { submission: "early-a", values: undefined },
      ],
      toLater: 0,
      afterNew: [{ submission: "late", values: { title: "Now" } }],
    });
  });

  it("tells no read as a form, whatever key it carries", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });

    const read = await sent(open, "notes.count", {}, "read-1");
    await drainWebhookDeliveries(env);

    expect({
      read: okOf(read),
      reached: await countAt(url),
    }).toStrictEqual({ read: true, reached: 0 });
  });

  it("sends nothing more for an App once it is removed, whatever was waiting", async () => {
    const open = await openNotes();
    const url = receiver();
    const { webhook } = await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const other = await personApi("builder");
    const { app: racing } = await notesApp(other);
    const raced = receiver();
    const { webhook: racedHook } = await other.api.apps.webhooks.add(racing, {
      url: raced,
      events: ["published"],
    });

    await sent(open, "notes.create", { title: "Waiting" }, "form-r");
    await open.builder.api.apps.archive(open.app);
    await open.builder.api.apps.remove(open.app);
    // One removed as the drain is about to send what it queued.
    await other.api.apps.publish(racing);
    await env.DB.prepare("UPDATE apps SET removed_at = ? WHERE id = ?")
      .bind(Date.now(), racing)
      .run();
    await drainWebhookDeliveries(env);

    expect({
      reached: (await countAt(url)) + (await countAt(raced)),
      left: [
        ...(await deliveriesOf(webhook.id)),
        ...(await deliveriesOf(racedHook.id)),
      ],
    }).toStrictEqual({ reached: 0, left: [] });
  });

  it("forgets what it settled once no repeat can come, and still tells a repeat within that time once", async () => {
    const open = await openNotes();
    const url = receiver();
    const { webhook } = await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });

    await sent(open, "notes.create", { title: "Old" }, "form-old");
    await drainWebhookDeliveries(env);
    // Settled longer ago than a repeat may come, though the form was told
    // just within it.
    const longAgo = Date.now() - formKeptMs - 60_000;
    await env.DB.prepare(
      "UPDATE app_webhook_deliveries SET delivered_at = ?, occurred_at = ? WHERE webhook_id = ?"
    )
      .bind(longAgo, longAgo, webhook.id)
      .run();
    await env.DB.prepare(
      "UPDATE app_form_submissions SET told_at = ? WHERE app_id = ?"
    )
      .bind(Date.now() - formKeptMs + 60_000, open.app)
      .run();
    // One waiting as long, never forgotten.
    await sent(open, "notes.create", { title: "Waiting" }, "form-wait");
    await env.DB.prepare(
      "UPDATE app_webhook_deliveries SET occurred_at = ?, delivery_at = ? WHERE webhook_id = ? AND delivered_at IS NULL"
    )
      .bind(longAgo, Date.now() + 3_600_000, webhook.id)
      .run();
    await drainWebhookDeliveries(env);
    const kept = await deliveriesOf(webhook.id);
    await sent(open, "notes.create", { title: "Old" }, "form-old");
    await drainWebhookDeliveries(env);

    expect({ kept, reached: await countAt(url) }).toStrictEqual({
      kept: [{ attempts: 0, outcome: null, settled: 0, has_values: 0 }],
      reached: 1,
    });
  });

  it("counts each delivery a full webhook misses, for its settings to show", async () => {
    const builder = await personApi("builder");
    const { app } = await notesApp(builder);
    const url = receiver();
    const { webhook } = await builder.api.apps.webhooks.add(app, {
      url,
      events: ["published"],
    });
    // As many waiting as it may hold, none of them due.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO app_webhook_deliveries (id, webhook_id, app_id, event, dedupe, occurred_at, delivery_at)
       SELECT lower(hex(randomblob(16))), ?, ?, 'published', 'full:' || i, ?, ? FROM n`
    )
      .bind(
        appWebhookLimits.waiting,
        webhook.id,
        app,
        Date.now(),
        Date.now() + 3_600_000
      )
      .run();

    await builder.api.apps.publish(app);
    const [listed] = await builder.api.apps.webhooks.list(app);
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS waiting FROM app_webhook_deliveries WHERE webhook_id = ? AND delivered_at IS NULL"
    )
      .bind(webhook.id)
      .all<{ waiting: number }>();

    expect({
      dropped: listed?.dropped,
      waiting: results[0]?.waiting,
    }).toStrictEqual({
      dropped: 1,
      waiting: appWebhookLimits.waiting,
    });
  });

  it("tells each run under a key once: a fresh one once the last one's receipt is gone, never a repeat of one", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const input = { title: "Again" };

    await sent(open, "notes.add", input, "fresh");
    await drainWebhookDeliveries(env);
    // The first run's receipt and its tombstone gone, so the key starts a
    // fresh run.
    const name = await invocationName(
      open.builder.userId,
      open.app,
      {
        reference: { name: "notes.add" },
      },
      "fresh",
      { streaming: false }
    );
    await runInDurableObject(
      env.ACTION_INVOCATIONS.getByName(name),
      (_instance, state) => {
        state.storage.kv.delete("invocation");
      }
    );
    const fresh = await sent(open, "notes.add", input, "fresh");
    // Its receipt answered again: the fresh run, told already.
    const again = await sent(open, "notes.add", input, "fresh");
    await drainWebhookDeliveries(env);
    const payloads = await payloadsAt(url);

    expect({
      answered: [okOf(fresh), okOf(again)],
      told: payloads.map(({ submission }) => submission),
      apart: new Set(payloads.map(({ id }) => id)).size,
    }).toStrictEqual({
      answered: [true, true],
      told: ["fresh", "fresh"],
      apart: 2,
    });
  });

  it("still tells a form's other webhooks when one is removed as it is told", async () => {
    const open = await openNotes();
    const [keptUrl, goneUrl] = [receiver(), receiver()];
    const { webhook: kept } = await open.builder.api.apps.webhooks.add(
      open.app,
      { url: keptUrl, events: ["form_sent"] }
    );
    const { webhook: gone } = await open.builder.api.apps.webhooks.add(
      open.app,
      { url: goneUrl, events: ["form_sent"] }
    );
    // Removed once its webhooks were read, as the form is marked told.
    const trigger = `remove_${gone.id.replaceAll("-", "_")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} AFTER INSERT ON app_form_submissions
       WHEN NEW.app_id = '${open.app}'
       BEGIN DELETE FROM app_webhooks WHERE id = '${gone.id}'; END`
    ).run();
    try {
      await sent(open, "notes.create", { title: "Racing" }, "form-race");
    } finally {
      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    await drainWebhookDeliveries(env);
    const listed = await open.builder.api.apps.webhooks.list(open.app);

    expect({
      listed: listed.map(({ id }) => id),
      kept: await countAt(keptUrl),
      gone: await countAt(goneUrl),
    }).toStrictEqual({ listed: [kept.id], kept: 1, gone: 0 });
  });

  it("tells a run once that was refused first and succeeded a day later, however often it is sent again", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    // Refused before anything ran under the key: nothing of it is kept.
    let deep: Json = "deep";
    for (let level = 0; level < 40; level += 1) {
      deep = [deep];
    }
    const refused = await sent(open, "notes.add", { title: deep }, "late-run");
    // The next day, it succeeds under the same key.
    const succeeded = await sent(
      open,
      "notes.add",
      { title: "Late" },
      "late-run"
    );
    await drainWebhookDeliveries(env);
    const dayAgo = Date.now() - 25 * 60 * 60_000;
    await env.DB.prepare(
      "UPDATE app_form_submissions SET told_at = ? WHERE app_id = ?"
    )
      .bind(dayAgo, open.app)
      .run();
    // Sent again past a day from the refusal: its receipt answers the run.
    const retried = await sent(
      open,
      "notes.add",
      { title: "Late" },
      "late-run"
    );
    await drainWebhookDeliveries(env);

    expect({
      answered: [okOf(refused), okOf(succeeded), okOf(retried)],
      reached: await countAt(url),
    }).toStrictEqual({ answered: [false, true, true], reached: 1 });
  });

  it("tells a streamed form once, however many follow or read its run again", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const input = { title: "Streamed" };

    const answers = [
      await streamed(open, "stream", "notes.write", input, "s-1"),
      // A second client reading the same run, and the first joining again.
      await streamed(open, "attach", "notes.write", input, "s-1"),
      await streamed(open, "stream", "notes.write", input, "s-1"),
    ];
    await drainWebhookDeliveries(env);
    const payloads = await payloadsAt(url);

    expect({
      answered: answers.map((answer) => okOf(answer)),
      told: payloads.map(({ submission, operation }) => ({
        submission,
        operation,
      })),
    }).toStrictEqual({
      answered: [true, true, true],
      told: [{ submission: "s-1", operation: undefined }],
    });
  });

  it("tells a streamed form once its run succeeds, though its page went away before the result", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const input = { title: "Left", pauseMs: 300 };

    const response = await routed(`${appFunctionPath}/${open.app}/stream`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie: open.builder.session,
        [pagePersonHeader]: open.builder.userId,
        [pageLeaseHeader]: open.lease,
      },
      body: JSON.stringify({
        reference: referenceOf(open, "notes.write"),
        input,
        idempotencyKey: "gone-s",
      }),
    });
    // Its first progress read, then the page closes.
    const reader = response.body?.getReader();
    const first = await reader?.read();
    await reader?.cancel();
    await reachedEventually(url, 1);
    // Read again, and joined again: the same run, told already.
    const attached = await streamed(
      open,
      "attach",
      "notes.write",
      input,
      "gone-s"
    );
    const joined = await streamed(
      open,
      "stream",
      "notes.write",
      input,
      "gone-s"
    );
    await drainWebhookDeliveries(env);

    expect({
      progressed: first?.done,
      answered: [okOf(attached), okOf(joined)],
      reached: await countAt(url),
    }).toStrictEqual({
      progressed: false,
      answered: [true, true],
      reached: 1,
    });
  });

  it("tells an action's form once its run succeeds, though nobody waited for its answer", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const input = { title: "Unheard", pauseMs: 300 };
    const call = { reference: referenceOf(open, "notes.add"), input };
    const name = await invocationName(
      open.builder.userId,
      open.app,
      call,
      "gone-a",
      { streaming: false }
    );
    const by = {
      userId: open.builder.userId,
      role: "builder" as const,
      teams: [],
    };

    // Started as the page's keyed action is, its answer never read.
    const frames = await env.ACTION_INVOCATIONS.getByName(name).open({
      by,
      access: await accessOf(env, by, open.app),
      app: open.app,
      name,
      call: { ...call, idempotencyKey: "gone-a" },
      streaming: false,
      attach: false,
      form: { key: "gone-a" },
    });
    await frames.cancel();
    await reachedEventually(url, 1);
    // Sent again under its key: its receipt answers, told already.
    const again = await sent(open, "notes.add", input, "gone-a");
    await drainWebhookDeliveries(env);

    expect({ again: okOf(again), reached: await countAt(url) }).toStrictEqual({
      again: true,
      reached: 1,
    });
  });

  it("tells no form a builder's preview of a draft sends, keyed or streamed", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const { id } = await open.builder.api.chats.forApp(open.app);
    const preview = await open.builder.api.chats.preview(id, open.app);
    const drafted = { builder: open.builder, lease: preview.lease ?? "" };
    const added = await sentOnly(
      open,
      "notes.add",
      { title: "Drafted" },
      "draft-a",
      drafted
    );
    const streamedOut = await streamed(
      { ...open, lease: drafted.lease },
      "stream",
      "notes.write",
      { title: "Streamed" },
      "draft-b"
    );
    // The App's own page's form is told: the webhook hears forms at all.
    await sent(open, "notes.add", { title: "Real" }, "real-a");
    await reachedEventually(url, 1);
    await drainWebhookDeliveries(env);

    expect({
      added: okOf(added),
      streamed: okOf(streamedOut),
      reached: await countAt(url),
    }).toStrictEqual({ added: true, streamed: true, reached: 1 });
  });

  it("keeps a succeeded action's form untold with its receipt while it can't be told, and tells it on the next try", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const call = {
      reference: referenceOf(open, "notes.add"),
      input: { title: "Held" },
    };
    const name = await invocationName(
      open.builder.userId,
      open.app,
      call,
      "held-a",
      { streaming: false }
    );
    const invocation = env.ACTION_INVOCATIONS.getByName(name);
    const untold = async () =>
      await runInDurableObject(invocation, (_instance, state) => {
        const record = state.storage.kv.get<{ untold?: unknown }>("invocation");
        return record?.untold !== undefined;
      });
    // Telling it fails: core's database refuses the write.
    const trigger = `refuse_${open.app.replaceAll("-", "_")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON app_form_submissions
       WHEN NEW.app_id = '${open.app}'
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`
    ).run();
    let answered: unknown;
    let heldBack: boolean;
    try {
      answered = await sent(open, "notes.add", call.input, "held-a");
      await drainWebhookDeliveries(env);
      heldBack = await untold();
    } finally {
      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    const whileRefused = await countAt(url);
    await runDurableObjectAlarm(invocation);
    await drainWebhookDeliveries(env);
    const after = { untold: await untold(), reached: await countAt(url) };
    // Sent again under its key: its receipt answers, told already.
    await sent(open, "notes.add", call.input, "held-a");
    await drainWebhookDeliveries(env);

    expect({
      answered: okOf(answered),
      heldBack,
      whileRefused,
      after,
      again: await countAt(url),
    }).toStrictEqual({
      answered: true,
      heldBack: true,
      whileRefused: 0,
      after: { untold: false, reached: 1 },
      again: 1,
    });
  });

  it("tells a committed mutation's form from its store's outbox, tried again while it can't be told, never lost, and keeps its values only until then", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const trigger = `refuse_${open.app.replaceAll("-", "_")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON app_form_submissions
       WHEN NEW.app_id = '${open.app}'
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`
    ).run();
    let answered: unknown;
    let owed: number;
    let keptWhileOwed: number;
    try {
      answered = await sentOnly(
        open,
        "notes.create",
        { title: "Kept" },
        "held-m"
      );
      await runDurableObjectAlarm(storeOf(open));
      await drainWebhookDeliveries(env);
      owed = await owedBy(open);
      keptWhileOwed = await valuesKeptBy(open);
    } finally {
      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    const whileRefused = await countAt(url);
    // Its next try, due now.
    await runInDurableObject(storeOf(open), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sdk_change_outbox SET next_attempt_at = 0 WHERE settled_at IS NULL"
      );
    });
    await storeHandsOver(open);
    await drainWebhookDeliveries(env);
    const reached = await countAt(url);
    const keptOnceTold = await valuesKeptBy(open);
    // Sent again under its key: its receipt answers, nothing new commits.
    await sent(open, "notes.create", { title: "Kept" }, "held-m");
    await drainWebhookDeliveries(env);

    expect({
      answered: okOf(answered),
      owed,
      keptWhileOwed,
      whileRefused,
      reached,
      keptOnceTold,
      again: await countAt(url),
    }).toStrictEqual({
      answered: true,
      owed: 1,
      keptWhileOwed: 1,
      whileRefused: 0,
      reached: 1,
      keptOnceTold: 0,
      again: 1,
    });
  });

  it("counts a form a full webhook missed once, however many tell it at the same moment", async () => {
    const open = await openNotes();
    const { webhook } = await open.builder.api.apps.webhooks.add(open.app, {
      url: receiver(),
      events: ["form_sent"],
    });
    // As many waiting as it may hold, none of them due.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO app_webhook_deliveries (id, webhook_id, app_id, event, dedupe, occurred_at, delivery_at)
       SELECT lower(hex(randomblob(16))), ?, ?, 'form_sent', 'full:' || i, ?, ? FROM n`
    )
      .bind(
        appWebhookLimits.waiting,
        webhook.id,
        open.app,
        Date.now(),
        Date.now() + 3_600_000
      )
      .run();
    const submission = formSubmissionOf({
      app: open.app,
      userId: open.builder.userId,
      call: {
        reference: referenceOf(open, "notes.add"),
        input: { title: "Twice" },
      },
      key: "twice",
      operation: "notes.add",
      startedAt: Date.now(),
    });

    // Two tells of one run, at the same millisecond.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      await Promise.all([
        queueFormSent(env, submission),
        queueFormSent(env, submission),
      ]);
    } finally {
      now.mockRestore();
    }
    const [listed] = await open.builder.api.apps.webhooks.list(open.app);

    expect(listed?.dropped).toBe(1);
  });

  it("keeps an action's tombstone to its end while its form can't be told, so the key stays refused", async () => {
    const open = await openNotes();
    const url = receiver();
    await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    const input = { title: "Late" };
    const call = { reference: referenceOf(open, "notes.add"), input };
    const name = await invocationName(
      open.builder.userId,
      open.app,
      call,
      "late-a",
      { streaming: false }
    );
    const invocation = env.ACTION_INVOCATIONS.getByName(name);
    const trigger = `refuse_${open.app.replaceAll("-", "_")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON app_form_submissions
       WHEN NEW.app_id = '${open.app}'
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`
    ).run();
    let state: unknown;
    let again: unknown;
    try {
      await sent(open, "notes.add", input, "late-a");
      // Its receipt's time over: the next alarm keeps it as a tombstone,
      // and the one after, a form's retry, comes long before its end.
      await runInDurableObject(invocation, (_instance, storage) => {
        const record =
          storage.storage.kv.get<Record<string, unknown>>("invocation");
        storage.storage.kv.put("invocation", {
          ...record,
          settledAt: Date.now() - streamRetentionMs - 60_000,
        });
      });
      await runDurableObjectAlarm(invocation);
      await runDurableObjectAlarm(invocation);
      state = await runInDurableObject(
        invocation,
        (_instance, storage) =>
          storage.storage.kv.get<{ state?: string }>("invocation")?.state
      );
      again = await sent(open, "notes.add", input, "late-a");
    } finally {
      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
    }

    expect({
      state,
      again: errorOf(again),
    }).toMatchObject({
      state: "expired",
      again: { code: "submission.expired" },
    });
  });

  it("commits a mutation whose input is as deep as a value may be, its form told without its values", async () => {
    const open = await openNotes();
    const url = receiver();
    const { webhook } = await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    await open.admin.api.apps.webhooks.approve(open.app, webhook.id);
    let deep: Json = "bottom";
    for (let level = 0; level < deepLevels; level += 1) {
      deep = [deep];
    }

    const answered = await sent(open, "notes.keepDeep", { deep }, "deep-1");
    await drainWebhookDeliveries(env);
    const payloads = await payloadsAt(url);

    expect({
      answered: okOf(answered),
      told: payloads.map(({ submission, values, valuesLeftOut }) => ({
        submission,
        values,
        valuesLeftOut,
      })),
    }).toStrictEqual({
      answered: true,
      told: [{ submission: "deep-1", values: undefined, valuesLeftOut: true }],
    });
  });

  it("has nothing to tell once a form's App is removed, so a run's receipt doesn't try again", async () => {
    const open = await openNotes();
    await open.builder.api.apps.webhooks.add(open.app, {
      url: receiver(),
      events: ["form_sent"],
    });
    const submission = formSubmissionOf({
      app: open.app,
      userId: open.builder.userId,
      call: {
        reference: referenceOf(open, "notes.add"),
        input: { title: "Gone" },
      },
      key: "gone-app",
      operation: "notes.add",
      startedAt: Date.now(),
    });
    await open.builder.api.apps.archive(open.app);
    await open.builder.api.apps.remove(open.app);

    const told = await queueFormSent(env, submission).then(
      () => "done",
      (error: unknown) => (error instanceof Error ? error.message : "failed")
    );
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS kept FROM app_form_submissions WHERE app_id = ?"
    )
      .bind(open.app)
      .all<{ kept: number }>();

    expect({ told, kept: results[0]?.kept }).toStrictEqual({
      told: "done",
      kept: 0,
    });
  });

  it("commits a mutation that stages near all a commit holds, its form told without the values that wouldn't fit", async () => {
    const open = await openNotes();
    const url = receiver();
    const { webhook } = await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    await open.admin.api.apps.webhooks.approve(open.app, webhook.id);
    // Seven blobs of 100 000 bytes and an answer near the most a function
    // returns: within what a mutation commits, not with a form of 60 000
    // bytes beside them.
    const input = { inserts: 7, answer: 250_000, pad: "p".repeat(60_000) };

    const answered = await sent(open, "notes.fill", input, "fill-1");
    await drainWebhookDeliveries(env);
    const payloads = await payloadsAt(url);

    expect({
      answered: okOf(answered),
      told: payloads.map(
        ({ submission, operation, values, valuesLeftOut }) => ({
          submission,
          operation,
          values,
          valuesLeftOut,
        })
      ),
    }).toStrictEqual({
      answered: true,
      told: [
        {
          submission: "fill-1",
          operation: "notes.fill",
          values: undefined,
          valuesLeftOut: true,
        },
      ],
    });
  });

  it("names a form by the action its run resolved: a run that can't resolve it fails, and its retry is told once", async () => {
    const open = await openNotes();
    const url = receiver();
    const { webhook } = await open.builder.api.apps.webhooks.add(open.app, {
      url,
      events: ["form_sent"],
    });
    await open.admin.api.apps.webhooks.approve(open.app, webhook.id);
    const by = {
      userId: open.builder.userId,
      role: "builder" as const,
      teams: [],
    };
    const input = { title: "Resolved" };
    // Started as a page's keyed action is, given only its key: what it
    // sends to is the run's own to resolve.
    const started = async (named: string, key: string) => {
      const call = {
        reference: { ...referenceOf(open, "notes.add"), name: named },
        input,
        idempotencyKey: key,
      };
      const name = await invocationName(
        open.builder.userId,
        open.app,
        call,
        key,
        { streaming: false }
      );
      const frames = await env.ACTION_INVOCATIONS.getByName(name).open({
        by,
        access: await accessOf(env, by, open.app),
        app: open.app,
        name,
        call,
        streaming: false,
        attach: false,
        form: { key },
      });
      const text = await new Response(frames).text();
      return resultOfLines(text);
    };

    // Its release can't resolve what it names: the run fails, told nothing.
    const failed = await started("notes.missing", "resolved-1");
    await drainWebhookDeliveries(env);
    const afterFailure = await countAt(url);
    const ran = await started("notes.add", "resolved-2");
    await drainWebhookDeliveries(env);
    const payloads = await payloadsAt(url);

    expect({
      failed: okOf(failed),
      afterFailure,
      ran: okOf(ran),
      told: payloads.map(({ submission, operation }) => ({
        submission,
        operation,
      })),
    }).toStrictEqual({
      failed: false,
      afterFailure: 0,
      ran: true,
      told: [{ submission: "resolved-2", operation: "notes.add" }],
    });
  });
});
