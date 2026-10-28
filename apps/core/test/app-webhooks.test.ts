import { appWebhookHeaders, signedTextOf } from "@grasp-os/shared/app-webhooks";
import { toHex } from "@grasp-os/shared/encoding";
import type { Json } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { drainWebhookDeliveries } from "../src/app-webhooks.ts";
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

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { action, mutation } from "#grasp/server";
import { v } from "@grasp-os/sdk";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const add = action({
  args: { title: v.string() },
  returns: v.string(),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: args.title });
    return args.title;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, create } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { add, create } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
  "screens/notes.tsx": `export default function Notes() {
  return <p>Notes</p>;
}
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
 * A builder's Notes App, published, its screen's build approved and open:
 * a screen that can send its forms.
 */
const openNotes = async () => {
  const [builder, admin] = await Promise.all([
    personApi("builder"),
    personApi("admin"),
  ]);
  const { app, version } = await notesApp(builder);
  await published(app);
  const review = await admin.api.screenTrust.review(app);
  await admin.api.screenTrust.approve(app, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const { lease } = await builder.api.screens.open(app, "notes");
  const release = await loadRelease(env, app, version);
  return { builder, admin, app, lease, release };
};

type Open = Awaited<ReturnType<typeof openNotes>>;

/** Sends `input` to `path` as the open screen does, under `key` if given. */
const sent = async (
  { builder, app, lease, release }: Open,
  path: string,
  input: Json,
  key?: string
): Promise<unknown> => {
  const response = await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: builder.session,
      [screenPersonHeader]: builder.userId,
      [screenLeaseHeader]: lease,
    },
    body: JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path],
        kind: release.app.operations[path]?.kind,
      },
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
});
