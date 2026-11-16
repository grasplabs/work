import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import { eventSourceHeaders } from "@grasp-os/shared/event-sources";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vite-plus/test";

import { grantPermission, listPermissions } from "../src/permissions.ts";
import { triggeredRunsPerHour } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";
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
  return await routed(
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
    sending.coreEnv
  );
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
      forBuilder: { ...source, delivery: null },
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
