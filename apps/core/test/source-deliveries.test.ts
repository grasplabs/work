import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import {
  eventSourceHeaders,
  eventSourceRetention,
} from "@grasp-os/shared/event-sources";
import type { EventSourcesApi } from "@grasp-os/shared/event-sources";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vite-plus/test";

import { grantPermission, listPermissions } from "../src/permissions.ts";
import { triggeredRunsPerHour } from "../src/workflows/runs.ts";
import { sweepSourceDeliveries } from "../src/workflows/source-deliveries.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { publishOverRpc } from "./workflow-publishing.ts";

// Event sources and the webhook triggers on them (event-sources.ts,
// workflows/source-events.ts), from their threat model: a delivery that
// isn't signed with the source's secret, one replayed past its window,
// one too large or not an event, one before an admin granted a trigger
// its start, a sender's retry of the same `webhook-id` signed afresh, a
// delivery cut off or failing half way and retried, one whose secret is
// rotated or whose source is deleted as it is admitted: each starts
// nothing more than it should. The secret is shown once to the admin who
// made it, never listed or audited, and builders never see the URL.
// Deliveries are signed by Standard Webhooks' own library, as any
// sender's are.

const idp = mockIdp();

/** An admin, straight in the database, to grant triggers their starts. */
const deciding = async (): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Admin', ?, 1, ?, ?)"
    ).bind(userId, `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'admin', ?)"
    ).bind(crypto.randomUUID(), userId, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Admin",
    role: "admin",
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** A workflow taking an invoice's number and amount, answering the number. */
const definitionOf = (): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({
      invoice: { kind: "string" },
      amount: { kind: "number", integer: true },
    }),
    returns: objectSchema({ invoice: { kind: "string" } }),
    result: { invoice: { $expr: "args.invoice" } },
    steps: [],
  });

/** An admin's new source, made over `/rpc`: its URL's token and its secret. */
const newSource = async () => {
  const admin = await signedInApi(idp, "admin");
  const { source, secret } = await admin.api.workflowResources.sources.create({
    name: `Shop ${unique()}`,
  });
  return { admin, source, secret, token: source.delivery?.token ?? "" };
};

/**
 * A builder's workflow with a webhook trigger of theirs on `source`'s
 * events of `type`, made over `/rpc`; the `start` it asked for as it was
 * created granted by an admin unless `grant` is false.
 */
const triggerOn = async (
  source: string,
  { type = "invoice.paid", grant = true } = {}
) => {
  const builder = await signedInApi(idp, "builder");
  const by = await deciding();
  const { id, name } = await builder.api.workflowResources.create(
    `hook-${unique()}`
  );
  await publishOverRpc(builder.api, id, definitionOf());
  const trigger = await builder.api.workflowResources.triggers.create({
    kind: "webhook",
    workflowId: id,
    config: { source, type },
  });
  if (grant) {
    // The request the trigger made as it was created.
    const [asked] = await listPermissions(
      env,
      by,
      { type: "trigger", triggerId: trigger.id },
      undefined,
      "requested"
    );
    await grantPermission(env, by, asked?.id ?? "", { version: null });
  }
  return { builder, workflow: id, workflowName: name, trigger };
};

/** How a test sends a delivery, when not as a sender holding the secret does. */
interface Sending {
  /** Its `webhook-id`: one of its own unless given. */
  id?: string;
  /** Signed with another secret than the source's. */
  secret?: string;
  /** Seconds from now its timestamp says. */
  skew?: number;
  /** Its `webhook-signature`, as is. */
  signature?: string;
  method?: string;
  /** Its body as a stream, in place of `body`. */
  stream?: ReadableStream<Uint8Array>;
  /** Core's env the request reaches. */
  coreEnv?: Env;
}

/**
 * Sends `body` to the source's URL at `token`, signed with `secret` by
 * Standard Webhooks' own library, as any sender of the standard signs.
 */
const send = async (
  token: string,
  secret: string,
  body: string,
  sending: Sending = {}
): Promise<Response> => {
  const id = sending.id ?? `msg_${unique()}`;
  const at = new Date(Date.now() + (sending.skew ?? 0) * 1000);
  const signature =
    sending.signature ??
    new Webhook(sending.secret ?? secret).sign(id, at, body);
  // What core writes after answering (what the source kept and counted)
  // is in before the test reads it.
  const ctx = createExecutionContext();
  const response = await routed(
    `${eventSourcePath}/${token}`,
    {
      method: sending.method ?? "POST",
      headers: {
        "content-type": "application/json",
        [eventSourceHeaders.id]: id,
        [eventSourceHeaders.timestamp]: String(Math.floor(at.getTime() / 1000)),
        [eventSourceHeaders.signature]: signature,
      },
      ...(sending.method === "GET"
        ? {}
        : { body: sending.stream ?? body, duplex: "half" }),
    },
    sending.coreEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
};

/** The inputs of the runs trigger `trigger` started, oldest first. */
const runInputsOf = async (trigger: string): Promise<unknown[]> => {
  const rows = await env.DB.prepare(
    "SELECT receipt.input FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE receipt.invoker_type = 'trigger' AND receipt.invoker_id = ? ORDER BY receipt.created_at"
  )
    .bind(trigger)
    .all<{ input: string | null }>();
  return rows.results.map(({ input }): unknown =>
    input === null ? null : JSON.parse(input)
  );
};

/**
 * Core's env with `first` run just before the `nth` statement (the first
 * unless given) whose query `at` matches is run: someone acting between
 * what core read and that statement, or core failing there (`first`
 * throwing).
 */
const racedAt = (at: RegExp, first: () => Promise<unknown>, nth = 1): Env => {
  const real = env.DB;
  let seen = 0;
  const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property, receiver) => {
        if (property === "bind") {
          return (...values: unknown[]) => racing(target.bind(...values));
        }
        if (
          property === "first" ||
          property === "all" ||
          property === "raw" ||
          property === "run"
        ) {
          return async (...args: unknown[]) => {
            await first();
            const run: unknown = Reflect.get(target, property, target);
            if (typeof run !== "function") {
              throw new TypeError(`No ${property} on a statement`);
            }
            const result: unknown = await Reflect.apply(run, target, args);
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
  const DB: D1Database = {
    prepare: (query) => {
      const statement = real.prepare(query);
      if (!at.test(query)) {
        return statement;
      }
      seen += 1;
      return seen === nth ? racing(statement) : statement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { ...env, DB };
};

/** The statement that admits a trigger's start (workflow-starts.ts). */
const admitting = /trigger_resources AS live/u;

/** An event's body: an invoice paid, of `type` unless given. */
const eventOf = (
  invoice = "INV-1",
  amount = 120,
  type = "invoice.paid"
): string => JSON.stringify({ type, data: { invoice, amount } });

describe("an event source", () => {
  it("shows its secret once, to the admin who made it, never in its listing or the audit log; builders see no URL", async () => {
    const { admin, source, secret, token } = await newSource();
    const builder = await signedInApi(idp, "builder");
    const member = await signedInApi(idp, "user");
    const listed = await admin.api.workflowResources.sources.list();
    const forBuilder = await builder.api.workflowResources.sources.list();
    const events = await allEvents();

    expect({
      secret: /^whsec_[A-Za-z0-9+/]{43}=$/u.test(secret),
      token: /^[0-9a-f]{32}$/u.test(token),
      listed: listed.find(({ id }) => id === source.id)?.delivery,
      secretListed: JSON.stringify(listed).includes(secret),
      forBuilder: forBuilder.find(({ id }) => id === source.id),
      builderCreates: await outcome(
        builder.api.workflowResources.sources.create({ name: "Mine" })
      ),
      memberLists: await outcome(member.api.workflowResources.sources.list()),
      audited: events
        .filter(({ target }) => target?.id === source.id)
        .map(({ action }) => action),
      secretAudited: JSON.stringify(events).includes(secret),
      tokenAudited: JSON.stringify(events).includes(token),
    }).toStrictEqual({
      secret: true,
      token: true,
      listed: { token, secret: "active" },
      secretListed: false,
      forBuilder: { ...source, delivery: null, activity: null },
      builderCreates: "role.forbidden",
      memberLists: "role.forbidden",
      audited: ["event_source.created"],
      secretAudited: false,
      tokenAudited: false,
    });
  });

  it("starts each trigger on the event's type once per webhook-id, its data the input: a retry signed afresh starts none, another ID one more", async () => {
    const { source, secret, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    const { trigger: also } = await triggerOn(source.id);
    const { trigger: otherType } = await triggerOn(source.id, {
      type: "invoice.voided",
    });
    const delivered = await send(token, secret, eventOf(), { id: "msg_1" });
    // The sender's retry: the same ID, a timestamp and signature of its own.
    const retried = await send(token, secret, eventOf(), {
      id: "msg_1",
      skew: 30,
    });
    const another = await send(token, secret, eventOf("INV-2", 2), {
      id: "msg_2",
    });

    expect({
      statuses: [delivered.status, retried.status, another.status],
      inputs: await runInputsOf(trigger.id),
      also: await runInputsOf(also.id),
      otherType: await runInputsOf(otherType.id),
    }).toStrictEqual({
      statuses: [202, 202, 202],
      inputs: [
        { invoice: "INV-1", amount: 120 },
        { invoice: "INV-2", amount: 2 },
      ],
      also: [
        { invoice: "INV-1", amount: 120 },
        { invoice: "INV-2", amount: 2 },
      ],
      otherType: [],
    });
  });

  it("refuses an unsigned, stale, oversized or malformed delivery, starting nothing, and audits one its workflow doesn't take", async () => {
    const { source, secret, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    const otherSecret = new Webhook(
      `whsec_${btoa("another-secret-of-32-bytes-long!")}`
    );
    const at = new Date();
    const body = eventOf();
    const refused = {
      wrongSecret: await send(token, secret, body, {
        signature: otherSecret.sign("msg_a", at, body),
        id: "msg_a",
      }),
      // Signed for another ID: the ID can't be swapped.
      swappedId: await send(token, secret, body, {
        signature: new Webhook(secret).sign("msg_b", at, body),
        id: "msg_c",
      }),
      tampered: await send(token, secret, body, {
        signature: new Webhook(secret).sign("msg_d", at, eventOf("INV-9", 1)),
        id: "msg_d",
      }),
      unsigned: await send(token, secret, body, { signature: "" }),
      stale: await send(token, secret, body, { skew: -600 }),
      future: await send(token, secret, body, { skew: 600 }),
      unknown: await send("0".repeat(32), secret, body),
      notPost: await send(token, secret, body, { method: "GET" }),
      oversized: await send(token, secret, eventOf("x".repeat(70 * 1024), 1)),
      notJson: await send(token, secret, "invoice=INV-1"),
      noType: await send(
        token,
        secret,
        JSON.stringify({ data: { invoice: "INV-1", amount: 1 } })
      ),
      // Signed and an event, but not an input its workflow takes: taken,
      // and the trigger's refusal audited.
      notInput: await send(
        token,
        secret,
        JSON.stringify({
          type: "invoice.paid",
          data: { invoice: "INV-3", amount: "lots" },
        })
      ),
    };
    const events = await allEvents();

    expect({
      statuses: Object.fromEntries(
        Object.entries(refused).map(([why, response]) => [why, response.status])
      ),
      inputs: await runInputsOf(trigger.id),
      audited: events
        .filter(
          ({ action, target }) =>
            action === "workflow.webhook.refused" && target?.id === trigger.id
        )
        .map(({ detail }) => ({ code: detail.code, source: detail.source })),
    }).toStrictEqual({
      statuses: {
        wrongSecret: 401,
        swappedId: 401,
        tampered: 401,
        unsigned: 401,
        stale: 401,
        future: 401,
        // As a revoked secret: a response never says a token exists.
        unknown: 401,
        notPost: 405,
        oversized: 413,
        notJson: 400,
        noType: 400,
        notInput: 202,
      },
      inputs: [],
      audited: [{ code: "workflow.start_invalid", source: source.id }],
    });
  });

  it("tells a sender past a trigger's hour to try again, holding nothing back, and starts one run once it has room", async () => {
    const { source, secret, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    // The hour's room taken by earlier deliveries.
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: triggeredRunsPerHour }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO trigger_hour_slots (trigger_id, event_key, taken_at) VALUES (?, ?, ?)"
        ).bind(trigger.id, `earlier-${index}`, now)
      )
    );
    const full = await send(token, secret, eventOf(), { id: "msg_busy" });
    const holds = await env.DB.prepare(
      "SELECT COUNT(*) AS kept FROM connector_trigger_holds WHERE trigger_id = ?"
    )
      .bind(trigger.id)
      .first<{ kept: number }>();
    const whileFull = await runInputsOf(trigger.id);
    // An hour on: the room is free again.
    await env.DB.prepare("DELETE FROM trigger_hour_slots WHERE trigger_id = ?")
      .bind(trigger.id)
      .run();
    const retried = await send(token, secret, eventOf(), {
      id: "msg_busy",
      skew: 30,
    });
    const again = await send(token, secret, eventOf(), {
      id: "msg_busy",
      skew: 60,
    });

    expect({
      full: full.status,
      retryAfter: full.headers.get("retry-after"),
      holds: holds?.kept,
      whileFull,
      retried: [retried.status, again.status],
      inputs: await runInputsOf(trigger.id),
    }).toStrictEqual({
      full: 503,
      retryAfter: "60",
      holds: 0,
      whileFull: [],
      retried: [202, 202],
      inputs: [{ invoice: "INV-1", amount: 120 }],
    });
  });

  it("starts nothing for a trigger until an admin grants its start, shown with its source and type", async () => {
    const { source, secret, token } = await newSource();
    const { workflow, workflowName, trigger, builder } = await triggerOn(
      source.id,
      { grant: false }
    );
    const decider = await signedInApi(idp, "admin");
    const waitingFor = async () => {
      const { items } = await decider.api.waiting.list();
      return items.flatMap((item) =>
        item.kind === "permissionRequest" &&
        item.request.subject.type === "trigger" &&
        item.request.subject.triggerId === trigger.id
          ? [item.request]
          : []
      );
    };
    const [asked] = await waitingFor();
    const beforeGrant = await send(token, secret, eventOf(), { id: "msg_1" });
    const before = await runInputsOf(trigger.id);
    await decider.api.waiting.settle({
      kind: "permissionRequest",
      id: asked?.id ?? "",
      verdict: "grant",
      reviewed: { version: null },
    });
    // The delivery refused before the grant stays refused; a new one starts.
    const sameAgain = await send(token, secret, eventOf(), { id: "msg_1" });
    const delivered = await send(token, secret, eventOf("INV-2", 2), {
      id: "msg_2",
    });
    const [listed] =
      await builder.api.workflowResources.triggers.list(workflow);

    expect({
      shown: asked && {
        object: asked.object,
        workflowNames: asked.workflowNames,
        kind: asked.trigger?.kind,
        event: asked.trigger?.event,
        source: asked.trigger?.source,
      },
      statuses: [beforeGrant.status, sameAgain.status, delivered.status],
      before,
      after: await runInputsOf(trigger.id),
      listed: { config: listed?.config, source: listed?.source },
    }).toStrictEqual({
      shown: {
        object: { type: "workflow", workflowId: workflow },
        workflowNames: { [workflow]: workflowName },
        kind: "webhook",
        event: "invoice.paid",
        source: { id: source.id, name: source.name, deleted: false },
      },
      statuses: [202, 202, 202],
      before: [],
      after: [{ invoice: "INV-2", amount: 2 }],
      listed: {
        config: { source: source.id, type: "invoice.paid" },
        source: { id: source.id, name: source.name, deleted: false },
      },
    });
  });

  it("takes only its newest secret once rotated, and none once revoked, until rotated again; only an admin rotates", async () => {
    const { admin, source, secret: first, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    const { sources } = admin.api.workflowResources;
    const { secret: second } = await sources.rotateSecret(source.id);
    const withFirst = await send(token, first, eventOf());
    const withSecond = await send(token, second, eventOf("INV-4", 4));
    const revoked = await sources.revokeSecret(source.id);
    const whileRevoked = await send(token, second, eventOf("INV-5", 5));
    const { secret: third } = await sources.rotateSecret(source.id);
    const withThird = await send(token, third, eventOf("INV-6", 6));
    const builder = await signedInApi(idp, "builder");
    const notTheirs = await outcome(
      builder.api.workflowResources.sources.rotateSecret(source.id)
    );

    expect({
      distinct: new Set([first, second, third]).size,
      statuses: [
        withFirst.status,
        withSecond.status,
        whileRevoked.status,
        withThird.status,
      ],
      revoked: revoked.delivery?.secret,
      notTheirs,
      inputs: await runInputsOf(trigger.id),
    }).toStrictEqual({
      distinct: 3,
      statuses: [401, 202, 401, 202],
      revoked: "revoked",
      notTheirs: "role.forbidden",
      inputs: [
        { invoice: "INV-4", amount: 4 },
        { invoice: "INV-6", amount: 6 },
      ],
    });
  });

  it("starts nothing for a delivery whose secret is rotated as it is admitted, and takes it again signed with the new one", async () => {
    const { admin, source, secret, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    let rotated = "";
    // The secret rotated after the delivery was checked, before its start
    // is admitted: the statement that admits it reads the source live.
    const rotating = racedAt(admitting, async () => {
      ({ secret: rotated } =
        await admin.api.workflowResources.sources.rotateSecret(source.id));
    });
    const raced = await send(token, secret, eventOf(), {
      id: "msg_race",
      coreEnv: rotating,
    });
    const before = await runInputsOf(trigger.id);
    // The sender's retry, signed with the new secret: nothing was settled.
    const retried = await send(token, rotated, eventOf(), { id: "msg_race" });

    expect({
      raced: raced.status,
      before,
      retried: retried.status,
      after: await runInputsOf(trigger.id),
    }).toStrictEqual({
      raced: 401,
      before: [],
      retried: 202,
      after: [{ invoice: "INV-1", amount: 120 }],
    });
  });

  it("takes nothing once deleted, not even a delivery it was admitting, and its triggers say so", async () => {
    const { admin, source, secret, token } = await newSource();
    const { trigger, workflow, builder } = await triggerOn(source.id);
    const deleting = racedAt(admitting, async () => {
      await admin.api.workflowResources.sources.delete(source.id);
    });
    const raced = await send(token, secret, eventOf(), {
      id: "msg_gone",
      coreEnv: deleting,
    });
    const after = await send(token, secret, eventOf(), { id: "msg_gone" });
    const [listed] =
      await builder.api.workflowResources.triggers.list(workflow);
    const listedSources = await admin.api.workflowResources.sources.list();
    const newTrigger = await outcome(
      builder.api.workflowResources.triggers.create({
        kind: "webhook",
        workflowId: workflow,
        config: { source: source.id, type: "invoice.paid" },
      })
    );
    const events = await allEvents();

    expect({
      statuses: [raced.status, after.status],
      inputs: await runInputsOf(trigger.id),
      source: listed?.source,
      listed: listedSources.some(({ id }) => id === source.id),
      newTrigger,
      audited: events
        .filter(({ target }) => target?.id === source.id)
        .map(({ action }) => action),
    }).toStrictEqual({
      statuses: [401, 401],
      inputs: [],
      source: { id: source.id, name: source.name, deleted: true },
      listed: false,
      newTrigger: "workflow.resource_invalid",
      audited: ["event_source.created", "event_source.deleted"],
    });
  });

  it("starts nothing for a delivery cut off as its body arrives, and starts it once when the sender tries again", async () => {
    const { source, secret, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    const body = eventOf();
    const half = new TextEncoder().encode(body.slice(0, 20));
    const cut = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(half);
        controller.error(new Error("The connection dropped"));
      },
    });
    // Answered with a failure, or never answered: either way not taken.
    const dropped = await send(token, secret, body, {
      id: "msg_cut",
      stream: cut,
    }).then(
      (response) => response.status,
      () => "never answered"
    );
    const before = await runInputsOf(trigger.id);
    const retried = await send(token, secret, body, { id: "msg_cut" });

    expect({
      taken: dropped === 202,
      before,
      retried: retried.status,
      after: await runInputsOf(trigger.id),
    }).toStrictEqual({
      taken: false,
      before: [],
      retried: 202,
      after: [{ invoice: "INV-1", amount: 120 }],
    });
  });

  it("asks a sender to try again when core fails between two triggers' starts, and starts each run once in all", async () => {
    const { source, secret, token } = await newSource();
    const { trigger: first } = await triggerOn(source.id);
    const { trigger: second } = await triggerOn(source.id);
    // Core failing just before it admits the second trigger's start, after
    // the first's landed: a worker killed mid-delivery.
    const failing = racedAt(
      admitting,
      async () => {
        await Promise.reject(new Error("The isolate was killed"));
      },
      2
    );
    const broken = await send(token, secret, eventOf(), {
      id: "msg_kill",
      coreEnv: failing,
    });
    const between = [
      ...(await runInputsOf(first.id)),
      ...(await runInputsOf(second.id)),
    ];
    // The sender's retry, on a fresh core: what landed is the same start.
    const retried = await send(token, secret, eventOf(), {
      id: "msg_kill",
      skew: 30,
    });

    expect({
      broken: broken.status,
      between: between.length,
      retried: retried.status,
      first: await runInputsOf(first.id),
      second: await runInputsOf(second.id),
    }).toStrictEqual({
      broken: 503,
      between: 1,
      retried: 202,
      first: [{ invoice: "INV-1", amount: 120 }],
      second: [{ invoice: "INV-1", amount: 120 }],
    });
  });
});

// What a source received, for its admins to see (workflows/source-
// deliveries.ts), from its threat model: an unauthenticated sender storing
// bytes of its own, flooding rows or probing for a source's URL; a sender
// holding the secret sending more than a source lists; anyone but an
// admin reading a payload, or an admin reading one unrecorded; a delivery
// read under another source's ID; a payload or a delivery outliving its
// window; a test event starting a run; a deleted source keeping anything.

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

/** The hours `since` to now covers: one, unless the test ran across one's end. */
const hoursSince = (since: number): number =>
  new Set([Math.floor(since / hourMs), Math.floor(Date.now() / hourMs)]).size;

/** What source `source` keeps in the database: its deliveries and its counts. */
const storedOf = async (source: string) => {
  const deliveries = await env.DB.prepare(
    "SELECT id, event_type AS type, test, triggers, payload FROM event_source_deliveries WHERE source_id = ? ORDER BY received_at, id"
  )
    .bind(source)
    .all<{
      id: string;
      type: string;
      test: number;
      triggers: number;
      payload: string | null;
    }>();
  const counts = await env.DB.prepare(
    "SELECT outcome, SUM(count) AS count, COUNT(*) AS rows FROM event_source_counts WHERE source_id = ? GROUP BY outcome ORDER BY outcome"
  )
    .bind(source)
    .all<{ outcome: string; count: number; rows: number }>();
  return { deliveries: deliveries.results, counts: counts.results };
};

/** How many rows the two tables hold, for every source together. */
const storedRows = async (): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM event_source_deliveries) + (SELECT COUNT(*) FROM event_source_counts) AS count"
  ).first<{ count: number }>();
  return row?.count ?? 0;
};

/** Moves everything source `source` kept and counted `ms` into the past. */
const aged = async (source: string, ms: number): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE event_source_deliveries SET received_at = received_at - ? WHERE source_id = ?"
    ).bind(ms, source),
    env.DB.prepare(
      "UPDATE event_source_counts SET hour = hour - ?, last_at = last_at - ? WHERE source_id = ?"
    ).bind(ms, ms, source),
  ]);
};

/** An admin's or a builder's `workflowResources.sources`. */
type Sources = Pick<EventSourcesApi, "list" | "deliveries">;

/** What source `source` received lately, as `sources` lists it. */
const activityOf = async (sources: Sources, source: string) => {
  const listed = await sources.list();
  return listed.find(({ id }) => id === source)?.activity;
};

/** The first page of source `source`'s deliveries. */
const deliveriesOf = async (sources: Sources, source: string) => {
  const page = await sources.deliveries(source);
  return page.deliveries;
};

/** D1 refusing a statement. */
const databaseDown = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("The database is down.");
};

/**
 * Core's env whose database fails every batch holding a statement whose
 * query `at` matches: D1 refusing what a source keeps of a delivery.
 */
const failingBatchOf = (at: RegExp): Env => {
  const real = env.DB;
  const queries = new WeakMap<D1PreparedStatement, string>();
  const remembered = (
    statement: D1PreparedStatement,
    query: string
  ): D1PreparedStatement => {
    queries.set(statement, query);
    return statement;
  };
  const DB: D1Database = {
    prepare: (query) => {
      const statement = real.prepare(query);
      const bind = statement.bind.bind(statement);
      return remembered(
        Object.assign(statement, {
          bind: (...values: unknown[]) => remembered(bind(...values), query),
        }),
        query
      );
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (statements.some((each) => at.test(queries.get(each) ?? ""))) {
        throw new Error("The database is down.");
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { ...env, DB };
};

/** The audit events of `action` on source `source`: their details. */
const auditedOn = async (source: string, action: string) => {
  const events = await allEvents();
  return {
    details: events
      .filter((event) => event.action === action && event.target?.id === source)
      .map(({ detail }) => detail),
    all: JSON.stringify(events),
  };
};

describe("what an event source received", () => {
  it("lists an accepted delivery with its type and time, its payload an admin's alone to read, audited once without it", async () => {
    const { admin, source, secret, token } = await newSource();
    const { builder } = await triggerOn(source.id);
    const member = await signedInApi(idp, "user");
    const marker = `INV-${unique()}`;
    const before = Date.now();
    const sent = await send(token, secret, eventOf(marker, 7));
    const after = Date.now();
    const { sources } = admin.api.workflowResources;
    const page = await sources.deliveries(source.id);
    const [listed] = page.deliveries;
    const read = await sources.delivery(source.id, listed?.id ?? "");
    const activity = await activityOf(sources, source.id);
    const theirs = builder.api.workflowResources.sources;
    const staffRpc = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = staffRpc.core.authenticate().workflowResources.sources;
    const refused = {
      builderLists: await outcome(theirs.deliveries(source.id)),
      builderReads: await outcome(theirs.delivery(source.id, listed?.id ?? "")),
      builderRefusals: await outcome(theirs.refusals(source.id)),
      builderTriggers: await outcome(theirs.triggers(source.id)),
      builderTests: await outcome(
        theirs.sendTest(source.id, { type: "invoice.paid", data: {} })
      ),
      memberLists: await outcome(
        member.api.workflowResources.sources.deliveries(source.id)
      ),
      staffLists: await outcome(staff.deliveries(source.id)),
      staffReads: await outcome(staff.delivery(source.id, listed?.id ?? "")),
      staffRefusals: await outcome(staff.refusals(source.id)),
      staffTriggers: await outcome(staff.triggers(source.id)),
      staffTests: await outcome(
        staff.sendTest(source.id, { type: "invoice.paid", data: {} })
      ),
    };
    const forBuilder = await activityOf(theirs, source.id);
    const audited = await auditedOn(source.id, "event_source.delivery.read");
    const at = new Date(listed?.receivedAt ?? 0).getTime();

    expect({
      status: sent.status,
      page: {
        ...page,
        deliveries: page.deliveries.map((delivery) => ({
          ...delivery,
          id: undefined,
          receivedAt: undefined,
        })),
      },
      listedHasPayload: JSON.stringify(page).includes(marker),
      receivedInTime: before <= at && at <= after,
      read: { ...read, id: read.id === listed?.id, receivedAt: undefined },
      activity: {
        ...activity,
        lastEventAt: activity?.lastEventAt === listed?.receivedAt,
      },
      refused,
      forBuilder,
      audited: audited.details,
      payloadAudited: audited.all.includes(marker),
    }).toStrictEqual({
      status: 202,
      page: {
        deliveries: [
          {
            id: undefined,
            receivedAt: undefined,
            type: "invoice.paid",
            test: false,
            triggersStarted: 1,
            payloadHeld: true,
          },
        ],
        next: null,
      },
      listedHasPayload: false,
      receivedInTime: true,
      read: {
        id: true,
        receivedAt: undefined,
        type: "invoice.paid",
        test: false,
        triggersStarted: 1,
        payloadHeld: true,
        payload: { invoice: marker, amount: 7 },
      },
      activity: { lastEventAt: true, acceptedLastDay: 1, refusedLastDay: 0 },
      refused: {
        builderLists: "role.forbidden",
        builderReads: "role.forbidden",
        builderRefusals: "role.forbidden",
        builderTriggers: "role.forbidden",
        builderTests: "role.forbidden",
        memberLists: "role.forbidden",
        staffLists: "role.forbidden",
        staffReads: "role.forbidden",
        staffRefusals: "role.forbidden",
        staffTriggers: "role.forbidden",
        staffTests: "role.forbidden",
      },
      forBuilder: null,
      audited: [{ delivery: listed?.id }],
      payloadAudited: false,
    });
  });

  it("counts a refused delivery by its reason and the hour and keeps nothing of it: fifty are one row, and a URL no source has counts nowhere", async () => {
    const { admin, source, secret, token } = await newSource();
    const { sources } = admin.api.workflowResources;
    const marker = `INV-${unique()}`;
    const body = eventOf(marker, 1);
    const forged = new Webhook(
      `whsec_${btoa("another-secret-of-32-bytes-long!")}`
    );
    const since = Date.now();
    const statuses = new Set<number>();
    for (let sent = 0; sent < 50; sent += 1) {
      const id = `msg_${marker}_${sent}`;
      // One after another, as a sender's flood arrives at one source.
      // oxlint-disable-next-line no-await-in-loop
      const response = await send(token, secret, body, {
        id,
        signature: forged.sign(id, new Date(), body),
      });
      statuses.add(response.status);
    }
    const stale = await send(token, secret, body, { skew: -600 });
    // Signed with its secret, and still not an event it takes.
    const oversized = await send(
      token,
      secret,
      eventOf(`${marker}${"x".repeat(70 * 1024)}`, 1)
    );
    const notAnEvent = await send(
      token,
      secret,
      JSON.stringify({ data: { invoice: marker } })
    );
    await sources.revokeSecret(source.id);
    const revoked = await send(token, secret, body);
    const rows = await storedRows();
    const unknown = await send("0".repeat(32), secret, body);
    const rowsAfterUnknown = await storedRows();
    const stored = await storedOf(source.id);
    const hours = hoursSince(since);
    const refusals = await sources.refusals(source.id);
    const activity = await activityOf(sources, source.id);

    expect({
      statuses: [...statuses, stale.status, revoked.status, unknown.status],
      signed: [oversized.status, notAnEvent.status],
      deliveries: stored.deliveries,
      signatureRows:
        (stored.counts.find((row) => row.outcome === "signature")?.rows ?? 0) <=
        hours,
      counts: stored.counts.map((row) => ({
        outcome: row.outcome,
        count: row.count,
      })),
      keptAnything: JSON.stringify(stored).includes(marker),
      unknownWrote: rowsAfterUnknown - rows,
      refusals: refusals.map(({ lastAt, ...rest }) => ({
        ...rest,
        lastAt: new Date(lastAt).getTime() >= since,
      })),
      activity,
    }).toStrictEqual({
      statuses: [401, 401, 401, 401],
      signed: [413, 400],
      deliveries: [],
      signatureRows: true,
      counts: [
        { outcome: "body", count: 1 },
        { outcome: "headers", count: 1 },
        { outcome: "revoked", count: 1 },
        { outcome: "signature", count: 50 },
        { outcome: "too_large", count: 1 },
      ],
      keptAnything: false,
      unknownWrote: 0,
      refusals: [
        { reason: "revoked", lastDay: 1, lastWeek: 1, lastAt: true },
        { reason: "headers", lastDay: 1, lastWeek: 1, lastAt: true },
        { reason: "signature", lastDay: 50, lastWeek: 50, lastAt: true },
        { reason: "too_large", lastDay: 1, lastWeek: 1, lastAt: true },
        { reason: "body", lastDay: 1, lastWeek: 1, lastAt: true },
      ],
      activity: { lastEventAt: null, acceptedLastDay: 0, refusedLastDay: 54 },
    });
  });

  it("holds a payload for a day and a delivery and its counts for seven, read as gone from then on and deleted on the clock", async () => {
    const { admin, source, secret, token } = await newSource();
    const { sources } = admin.api.workflowResources;
    await send(token, secret, eventOf());
    await send(token, secret, eventOf(), { skew: -600 });
    const [fresh] = await deliveriesOf(sources, source.id);
    const id = fresh?.id ?? "";
    // A day and an hour on.
    await aged(source.id, dayMs + hourMs);
    const [dayOld] = await deliveriesOf(sources, source.id);
    const readDayOld = await sources.delivery(source.id, id);
    const activityDayOld = await activityOf(sources, source.id);
    const refusalsDayOld = await sources.refusals(source.id);
    const reads = await auditedOn(source.id, "event_source.delivery.read");
    const beforeSweep = await storedOf(source.id);
    await sweepSourceDeliveries(env);
    const afterSweep = await storedOf(source.id);
    // Seven days and an hour on.
    await aged(source.id, 6 * dayMs);
    const weekOld = await sources.deliveries(source.id);
    const readWeekOld = await outcome(sources.delivery(source.id, id));
    const activityWeekOld = await activityOf(sources, source.id);
    const refusalsWeekOld = await sources.refusals(source.id);
    await sweepSourceDeliveries(env);

    expect({
      fresh: fresh?.payloadHeld,
      dayOld: dayOld?.payloadHeld,
      readDayOld: readDayOld.payload,
      activityDayOld: {
        ...activityDayOld,
        lastEventAt: activityDayOld?.lastEventAt === dayOld?.receivedAt,
      },
      refusalsDayOld: refusalsDayOld.map((refusal) => ({
        ...refusal,
        lastAt: undefined,
      })),
      reads: reads.details,
      storedBeforeSweep: beforeSweep.deliveries.map(({ payload }) => payload),
      storedAfterSweep: afterSweep.deliveries.map(({ payload }) => payload),
      weekOld,
      readWeekOld,
      activityWeekOld,
      refusalsWeekOld,
      storedAtLast: await storedOf(source.id),
    }).toStrictEqual({
      fresh: true,
      dayOld: false,
      readDayOld: null,
      activityDayOld: {
        lastEventAt: true,
        acceptedLastDay: 0,
        refusedLastDay: 0,
      },
      refusalsDayOld: [
        { reason: "headers", lastDay: 0, lastWeek: 1, lastAt: undefined },
      ],
      reads: [],
      storedBeforeSweep: ['{"invoice":"INV-1","amount":120}'],
      storedAfterSweep: [null],
      weekOld: { deliveries: [], next: null },
      readWeekOld: "webhook.delivery_unavailable",
      activityWeekOld: {
        lastEventAt: null,
        acceptedLastDay: 0,
        refusedLastDay: 0,
      },
      refusalsWeekOld: [],
      storedAtLast: { deliveries: [], counts: [] },
    });
  });

  it("answers a delivery read under another source's ID as one that isn't there, auditing nothing", async () => {
    const { admin, source } = await newSource();
    const other = await newSource();
    await send(other.token, other.secret, eventOf());
    const { sources } = admin.api.workflowResources;
    const [theirs] = await deliveriesOf(sources, other.source.id);
    const refused = {
      underAnother: await outcome(
        sources.delivery(source.id, theirs?.id ?? "")
      ),
      noSuchDelivery: await outcome(
        sources.delivery(other.source.id, crypto.randomUUID())
      ),
      noSuchSource: await outcome(sources.deliveries(crypto.randomUUID())),
      noSuchPage: await outcome(sources.deliveries(other.source.id, "last")),
    };
    const own = await auditedOn(source.id, "event_source.delivery.read");
    const others = await auditedOn(
      other.source.id,
      "event_source.delivery.read"
    );
    const reads = [...own.details, ...others.details];

    expect({ listed: theirs?.type, refused, reads }).toStrictEqual({
      listed: "invoice.paid",
      refused: {
        underAnother: "webhook.delivery_unavailable",
        noSuchDelivery: "webhook.delivery_unavailable",
        noSuchSource: "webhook.source_unavailable",
        noSuchPage: "webhook.page_invalid",
      },
      reads: [],
    });
  });

  it("keeps a test event marked a test and says which triggers match it, starting no run and keeping it for no wait, audited once", async () => {
    const { admin, source } = await newSource();
    const granted = await triggerOn(source.id);
    const waiting = await triggerOn(source.id, { grant: false });
    const otherType = await triggerOn(source.id, { type: "invoice.voided" });
    const { sources } = admin.api.workflowResources;
    const marker = `INV-${unique()}`;
    const test = await sources.sendTest(source.id, {
      type: "invoice.paid",
      data: { invoice: marker, amount: 3 },
    });
    const read = await sources.delivery(source.id, test.delivery.id);
    const invalid = {
      noType: await outcome(sources.sendTest(source.id, { data: {} })),
      notAType: await outcome(
        sources.sendTest(source.id, { type: " invoice.paid", data: {} })
      ),
      more: await outcome(
        sources.sendTest(source.id, {
          type: "invoice.paid",
          data: {},
          headers: {},
        })
      ),
      oversized: await outcome(
        sources.sendTest(source.id, {
          type: "invoice.paid",
          data: { invoice: "x".repeat(70 * 1024) },
        })
      ),
      noSuchSource: await outcome(
        sources.sendTest(crypto.randomUUID(), {
          type: "invoice.paid",
          data: {},
        })
      ),
    };
    const kept = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM kept_events WHERE source_id = ?"
    )
      .bind(source.id)
      .first<{ count: number }>();
    const audited = await auditedOn(source.id, "event_source.test_sent");
    const listed = await deliveriesOf(sources, source.id);
    const activity = await activityOf(sources, source.id);

    expect({
      delivery: { ...test.delivery, id: undefined, receivedAt: undefined },
      matched: test.matched,
      payload: read.payload,
      listed: listed.map(({ id, test: marked }) => ({
        same: id === test.delivery.id,
        marked,
      })),
      invalid,
      started: [
        await runInputsOf(granted.trigger.id),
        await runInputsOf(waiting.trigger.id),
        await runInputsOf(otherType.trigger.id),
      ],
      kept: kept?.count,
      activity,
      audited: audited.details,
      payloadAudited: audited.all.includes(marker),
    }).toStrictEqual({
      delivery: {
        id: undefined,
        receivedAt: undefined,
        type: "invoice.paid",
        test: true,
        triggersStarted: 0,
        payloadHeld: true,
      },
      matched: [
        {
          id: granted.trigger.id,
          type: "invoice.paid",
          enabled: true,
          start: "active",
          workflow: { id: granted.workflow, name: granted.workflowName },
        },
        {
          id: waiting.trigger.id,
          type: "invoice.paid",
          enabled: true,
          start: "requested",
          workflow: { id: waiting.workflow, name: waiting.workflowName },
        },
      ],
      payload: { invoice: marker, amount: 3 },
      listed: [{ same: true, marked: true }],
      invalid: {
        noType: "webhook.test_invalid",
        notAType: "webhook.test_invalid",
        more: "webhook.test_invalid",
        oversized: "webhook.test_invalid",
        noSuchSource: "webhook.source_unavailable",
      },
      started: [[], [], []],
      kept: 0,
      activity: { lastEventAt: null, acceptedLastDay: 0, refusedLastDay: 0 },
      audited: [
        { delivery: test.delivery.id, event: "invoice.paid", matched: 2 },
      ],
      payloadAudited: false,
    });
  });

  it("lists a source's live triggers with their workflows in one call, for an admin alone", async () => {
    const { admin, source } = await newSource();
    const other = await newSource();
    const paid = await triggerOn(source.id);
    const voided = await triggerOn(source.id, {
      type: "invoice.voided",
      grant: false,
    });
    const deleted = await triggerOn(source.id);
    await triggerOn(other.source.id);
    await deleted.builder.api.workflowResources.triggers.delete(
      deleted.trigger.id
    );
    await paid.builder.api.workflowResources.triggers.setEnabled(
      paid.trigger.id,
      false
    );

    expect({
      triggers: await admin.api.workflowResources.sources.triggers(source.id),
      // Not even its own trigger's builder: what they may see is their
      // workflow's Triggers tab.
      forItsBuilder: await outcome(
        paid.builder.api.workflowResources.sources.triggers(source.id)
      ),
      noSuchSource: await outcome(
        admin.api.workflowResources.sources.triggers(crypto.randomUUID())
      ),
    }).toStrictEqual({
      triggers: [
        {
          id: paid.trigger.id,
          type: "invoice.paid",
          enabled: false,
          start: "active",
          workflow: { id: paid.workflow, name: paid.workflowName },
        },
        {
          id: voided.trigger.id,
          type: "invoice.voided",
          enabled: true,
          start: "requested",
          workflow: { id: voided.workflow, name: voided.workflowName },
        },
      ],
      forItsBuilder: "role.forbidden",
      noSuchSource: "webhook.source_unavailable",
    });
  });

  it("lists a source's newest deliveries only, a page at a time, and counts every one it accepted", async () => {
    const { admin, source, secret, token } = await newSource();
    const { sources } = admin.api.workflowResources;
    // As many as it lists, older than what comes next.
    await env.DB.prepare(
      `WITH RECURSIVE older(nth) AS (
         SELECT 1 UNION ALL SELECT nth + 1 FROM older WHERE nth < ?)
       INSERT INTO event_source_deliveries
       SELECT printf('%036d', nth), ?, ? - nth, 'seeded', 0, 0, NULL FROM older`
    )
      .bind(eventSourceRetention.perSource, source.id, Date.now() - hourMs)
      .run();
    await send(token, secret, eventOf());
    await send(token, secret, eventOf("INV-2", 2));
    const stored = await storedOf(source.id);
    const first = await sources.deliveries(source.id);
    const second = await sources.deliveries(source.id, first.next ?? "");
    const ids = [...first.deliveries, ...second.deliveries].map(({ id }) => id);
    const times = [...first.deliveries, ...second.deliveries].map(
      ({ receivedAt }) => receivedAt
    );
    const activity = await activityOf(sources, source.id);

    expect({
      stored: stored.deliveries.length,
      oldestKept: stored.deliveries[0]?.id,
      firstPage: first.deliveries.length,
      newest: first.deliveries.slice(0, 2).map(({ type }) => type),
      secondPage: second.deliveries.length,
      more: second.next !== null,
      distinct: new Set(ids).size,
      newestFirst: times.toSorted().toReversed().join(",") === times.join(","),
      accepted: activity?.acceptedLastDay,
    }).toStrictEqual({
      stored: eventSourceRetention.perSource,
      // The two oldest made room for the two that came.
      oldestKept: String(eventSourceRetention.perSource - 2).padStart(36, "0"),
      firstPage: eventSourceRetention.pageSize,
      newest: ["invoice.paid", "invoice.paid"],
      secondPage: eventSourceRetention.pageSize,
      more: true,
      distinct: 2 * eventSourceRetention.pageSize,
      newestFirst: true,
      accepted: 2,
    });
  });

  it("deletes what a source kept and counted with it, and writes nothing for it after, not even for a delivery it was admitting", async () => {
    const { admin, source, secret, token } = await newSource();
    await triggerOn(source.id);
    const { sources } = admin.api.workflowResources;
    await send(token, secret, eventOf());
    await send(token, secret, eventOf(), { skew: -600 });
    await sources.sendTest(source.id, { type: "invoice.paid", data: {} });
    const before = await storedOf(source.id);
    const deleting = racedAt(admitting, async () => {
      await sources.delete(source.id);
    });
    const raced = await send(token, secret, eventOf("INV-2", 2), {
      coreEnv: deleting,
    });
    const after = await send(token, secret, eventOf("INV-3", 3));

    expect({
      before: {
        deliveries: before.deliveries.map(({ test }) => test),
        counts: before.counts.map((row) => ({
          outcome: row.outcome,
          count: row.count,
        })),
      },
      statuses: [raced.status, after.status],
      stored: await storedOf(source.id),
      listing: await outcome(sources.deliveries(source.id)),
      refusals: await outcome(sources.refusals(source.id)),
    }).toStrictEqual({
      before: {
        deliveries: [0, 1],
        counts: [
          { outcome: "accepted", count: 1 },
          { outcome: "headers", count: 1 },
        ],
      },
      statuses: [401, 401],
      stored: { deliveries: [], counts: [] },
      listing: "webhook.source_unavailable",
      refusals: "webhook.source_unavailable",
    });
  });

  it("lists a sender's retry of the same webhook-id once, as the one delivery that started its one run", async () => {
    const { admin, source, secret, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    const { sources } = admin.api.workflowResources;
    const id = `msg_${unique()}`;
    const first = await send(token, secret, eventOf(), { id });
    // The sender timed out and sends it again, signed afresh.
    const retried = await send(token, secret, eventOf(), { id, skew: 30 });
    const listed = await deliveriesOf(sources, source.id);
    const activity = await activityOf(sources, source.id);

    expect({
      statuses: [first.status, retried.status],
      runs: await runInputsOf(trigger.id),
      listed: listed.map(({ type, triggersStarted }) => ({
        type,
        triggersStarted,
      })),
      accepted: activity?.acceptedLastDay,
    }).toStrictEqual({
      statuses: [202, 202],
      runs: [{ invoice: "INV-1", amount: 120 }],
      listed: [{ type: "invoice.paid", triggersStarted: 1 }],
      accepted: 1,
    });
  });

  it("counts a delivery whose secret was rotated as it was admitted, keeping nothing of it", async () => {
    const { admin, source, secret, token } = await newSource();
    await triggerOn(source.id);
    const { sources } = admin.api.workflowResources;
    const rotating = racedAt(admitting, async () => {
      await sources.rotateSecret(source.id);
    });
    const raced = await send(token, secret, eventOf(), { coreEnv: rotating });
    const stored = await storedOf(source.id);

    expect({
      status: raced.status,
      deliveries: stored.deliveries,
      counts: stored.counts.map((row) => ({
        outcome: row.outcome,
        count: row.count,
      })),
    }).toStrictEqual({
      status: 401,
      deliveries: [],
      counts: [{ outcome: "rotated", count: 1 }],
    });
  });

  it("answers a delivery as it would when what it keeps or counts can't be written", async () => {
    const { source, secret, token } = await newSource();
    const { trigger } = await triggerOn(source.id);
    const uncounted = await send(token, secret, eventOf(), {
      skew: -600,
      coreEnv: racedAt(/event_source_counts/u, databaseDown),
    });
    const unkept = await send(token, secret, eventOf(), {
      coreEnv: failingBatchOf(/event_source_deliveries/u),
    });

    expect({
      statuses: [uncounted.status, unkept.status],
      runs: await runInputsOf(trigger.id),
      stored: await storedOf(source.id),
    }).toStrictEqual({
      statuses: [401, 202],
      runs: [{ invoice: "INV-1", amount: 120 }],
      stored: { deliveries: [], counts: [] },
    });
  });
});
