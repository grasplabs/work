import { brainOf, vectorModelNameOf } from "@grasp-os/brain-next/contract";
import type { Embedders } from "@grasp-os/brain-next/contract";
import {
  defineWork,
  enqueueWork,
  workAttemptsMax,
} from "@grasp-os/brain-next/work";
import { adminSnapshotPurpose } from "@grasp-os/shared/admin-snapshot";
import {
  brainActionPath,
  brainActionPurpose,
  brainReportPath,
  brainReportPurpose,
  brainReportSchema,
} from "@grasp-os/shared/brain-report";
import type { BrainAction, BrainReport } from "@grasp-os/shared/brain-report";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { embedInProcess } from "../../../packages/embed/test/test-models.ts";
import {
  addSource,
  brainWorkOverview,
  eraseSource,
  workBrain,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  copyOfStore,
  killStore,
  restoreStore,
} from "./brain-next-store-copy.ts";
import { failingAuditLog } from "./failing-audit-log.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, routed, signedInWithRole } from "./sign-in.ts";

// Grasp's staff's view of this client's Brain (src/brain-report.ts),
// asked as the admin asks: through the router, signed for its purpose,
// naming the staff member. The ways it can fail, tried first:
//
// - Anyone but the admin reading it or acting: unsigned, signed with a
//   made-up signature, with the admin's key for another purpose or
//   another client, sent long ago, too large, malformed, or with a
//   member's session; a read's signed body sent as an action; a read
//   signed with an action's key, or an action with a read's.
// - A read or an action the company can't see in its audit log, or one
//   served or applied when the log can't take it.
// - Content reaching staff: a source's text, a work item's key or what it
//   carries, an erased source's key, or the hash the ledger names it by.
// - An action recorded as done that wasn't: one the store refused while
//   it reads its ledger, or one with nothing to do.

const idp = mockIdp();

/** The Grasp staff member the admin says is asking. */
const staffEmail = "grace.hopper@grasp.test";

/** The Brain's one store, as the tests reach into it to add items. */
const storeObject = () =>
  inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** Words nobody else uses, to look for where they must not be. */
const marker = () => `Quokka${crypto.randomUUID().replaceAll("-", "")}`;

/** The keys whose items may run; every other one fails. */
const allowed = new Set<string>();
/** The keys whose items ran and succeeded. */
const ran = new Set<string>();

const flakyWork = defineWork({
  kind: `test.flaky_${crypto.randomUUID().replaceAll("-", "")}`,
  payload: z.strictObject({ key: z.string(), marked: z.string() }),
  timeLimitMs: 1000,
  run: async ({ key, marked }) => {
    await Promise.resolve();
    if (!allowed.has(key)) {
      throw new Error(`Could not read ${marked}`);
    }
    ran.add(key);
  },
});

/** The queue's own time: only forward, a day a tick, past every backoff. */
const queueClock = { at: Date.now() };
const nextDay = (): Date => {
  queueClock.at = Math.max(queueClock.at, Date.now()) + 24 * 60 * 60_000;
  return new Date(queueClock.at);
};

/** Ticks of core's clock, a day apart. */
const tick = async (times: number): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick after another
    await workBrain(env, nextDay());
  }
};

/**
 * An item whose key and payload carry `marked`, worked until it is parked
 * after its last attempt failed with `marked` in its error: its key, and
 * its id in the queue.
 */
const parked = async (marked: string): Promise<{ key: string; id: number }> => {
  const key = `${marked}-key`;
  await runInDurableObject(storeObject(), (_store, state) => {
    enqueueWork(state.storage, flakyWork, {
      key,
      payload: { key, marked },
      priority: "asked",
    });
  });
  await tick(workAttemptsMax);
  const overview = await brainWorkOverview(env);
  const item = overview.parked.find((each) => each.key === key);
  if (item === undefined) {
    throw new Error("The item wasn't parked");
  }
  return { key, id: item.id };
};

/** Whether the item `id` is parked now. */
const isParked = async (id: number): Promise<boolean> => {
  const overview = await brainWorkOverview(env);
  return overview.parked.some((item) => item.id === id);
};

/** `body`'s signature as the admin makes it, with the key `secret` gives. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = brainReportPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** A request's body, as the admin sends it: now, for `staffEmail`, with `fields`. */
const bodyOf = (
  fields: Record<string, unknown> = {},
  sentAt = new Date().toISOString()
): string =>
  JSON.stringify({ sentAt, staff: { email: staffEmail }, ...fields });

/** Posts `body` to `path` through the router, as given. */
const post = async (
  path: string,
  body: string,
  {
    signature = null,
    cookie = null,
    method = "POST",
    coreEnv = env,
  }: {
    signature?: string | null;
    cookie?: string | null;
    method?: string;
    coreEnv?: Env;
  } = {}
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  return await routed(
    path,
    { method, headers, ...(method === "POST" ? { body } : {}) },
    coreEnv
  );
};

/** Reads the report as the admin does: its answer's text and the report in it. */
const readReport = async (
  coreEnv: Env = env
): Promise<{ status: number; text: string; report: BrainReport | null }> => {
  const body = bodyOf();
  const response = await post(brainReportPath, body, {
    signature: await signatureOf(body),
    coreEnv,
  });
  const text = await response.text();
  const parsed = brainReportSchema.safeParse(
    response.ok ? JSON.parse(text) : null
  );
  return {
    status: response.status,
    text,
    report: parsed.success ? parsed.data : null,
  };
};

/** Acts as the admin does: the status and what it answered. */
const act = async (
  action: BrainAction,
  coreEnv: Env = env
): Promise<{ status: number; answer: unknown }> => {
  const body = bodyOf({ action });
  const response = await post(brainActionPath, body, {
    signature: await signatureOf(
      body,
      env.BETTER_AUTH_SECRET,
      brainActionPurpose
    ),
    coreEnv,
  });
  const text = await response.text();
  return {
    status: response.status,
    answer: response.ok ? JSON.parse(text) : null,
  };
};

/** What the admin reads of the report now: `pick` of it. */
const reported = async <T>(
  pick: (report: BrainReport | null) => T
): Promise<T> => {
  const { report } = await readReport();
  return pick(report);
};

/** The store's size, as a report says it. */
const bytesOf = (report: BrainReport | null): number =>
  report?.store.bytes ?? 0;

/** Whether the word indexes are current, as a report says it. */
const wordsOf = (report: BrainReport | null) => report?.words;

/** What an action answered, as the admin asked it. */
const answerTo = async (action: BrainAction): Promise<unknown> => {
  const { answer } = await act(action);
  return answer;
};

/** The Brain's audit events among `events`: action, actor and detail. */
const brainEvents = (
  events: readonly { action: string; actor: unknown; detail?: unknown }[]
) =>
  events
    .filter(({ action }) => action.startsWith("admin.brain."))
    .map(({ action, actor, detail }) => ({ action, actor, detail }));

const staffActor = { type: "staff", userId: staffEmail, via: "console" };

describe("who reads and acts on the Brain's report", () => {
  it("refuses anyone but the admin, records nothing and changes nothing", async () => {
    const { id } = await parked(marker());
    const member = await signedInWithRole(idp, "user");
    const read = bodyOf();
    const requeue = bodyOf({ action: { type: "requeue", item: id } });
    const old = bodyOf({}, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const large = bodyOf({ pad: "x".repeat(2048) });
    const noStaff = JSON.stringify({ sentAt: new Date().toISOString() });
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const responses = await Promise.all([
        post(brainReportPath, read),
        post(brainReportPath, read, { signature: "0".repeat(64) }),
        post(brainReportPath, read, {
          signature: await signatureOf(read, "another-client-auth-secret"),
        }),
        // The admin's key for the snapshot signs nothing here.
        post(brainReportPath, read, {
          signature: await signatureOf(
            read,
            env.BETTER_AUTH_SECRET,
            adminSnapshotPurpose
          ),
        }),
        post(brainReportPath, read, { cookie: member.session }),
        post(brainReportPath, old, { signature: await signatureOf(old) }),
        post(brainReportPath, large, { signature: await signatureOf(large) }),
        post(brainReportPath, noStaff, {
          signature: await signatureOf(noStaff),
        }),
        post(brainReportPath, read, {
          signature: await signatureOf(read),
          method: "GET",
        }),
        post(brainActionPath, requeue),
        post(brainActionPath, requeue, { cookie: member.session }),
        post(brainActionPath, requeue, {
          signature: await signatureOf(
            requeue,
            env.BETTER_AUTH_SECRET,
            adminSnapshotPurpose
          ),
        }),
        // A read's key signs no action, and an action's key no read.
        post(brainActionPath, requeue, {
          signature: await signatureOf(requeue),
        }),
        post(brainReportPath, read, {
          signature: await signatureOf(
            read,
            env.BETTER_AUTH_SECRET,
            brainActionPurpose
          ),
        }),
        // A read, signed as an action, is no action.
        post(brainActionPath, read, {
          signature: await signatureOf(
            read,
            env.BETTER_AUTH_SECRET,
            brainActionPurpose
          ),
        }),
      ]);
      statuses.push(...responses.map(({ status }) => status));
      await Promise.all(responses.map(async (each) => await each.text()));
    });
    const stillParked = await isParked(id);

    expect({
      statuses,
      events: brainEvents(events),
      stillParked,
    }).toStrictEqual({
      statuses: [
        401, 401, 401, 401, 401, 403, 403, 403, 404, 401, 401, 401, 401, 401,
        403,
      ],
      events: [],
      stillParked: true,
    });
  });

  it("answers nothing, and applies nothing, when the audit log can't take it", async () => {
    const { id } = await parked(marker());
    // The failed requests are logged as errors: that's what they are.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const failing = { ...env, AUDIT_LOG: failingAuditLog() };
    const read = await readReport(failing);
    const requeued = await act({ type: "requeue", item: id }, failing);
    logged.mockRestore();
    const stillParked = await isParked(id);

    expect({
      read: read.status,
      requeued: requeued.status,
      stillParked,
    }).toStrictEqual({ read: 500, requeued: 500, stillParked: true });
  });
});

describe("the Brain's report", () => {
  it("shows the queue, the store and the ledger, with nothing of the content, and records the read", async () => {
    const marked = marker();
    const person = `person-${crypto.randomUUID()}`;
    const kept = { producer: "upload" as const, id: crypto.randomUUID() };
    const erased = { producer: "upload" as const, id: crypto.randomUUID() };
    for (const source of [kept, erased]) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await addSource(env, {
        source,
        change: crypto.randomUUID(),
        text: `${marked} is what the board decided about the merger.`,
        readers: { kind: "owner", personId: person },
      });
    }
    await eraseSource(env, { source: erased, reason: "deleted" });
    const { key, id } = await parked(marked);

    const reads: Awaited<ReturnType<typeof readReport>>[] = [];
    const events = await auditedDuring(async () => {
      reads.push(await readReport());
    });
    const [{ status, text, report } = { status: 0, text: "", report: null }] =
      reads;
    const item = report?.queue.parked.find((each) => each.item === id);
    const subject = await sha256Hex(`upload:${erased.id}`);

    expect({
      status,
      // Neither the source's text, the item's key or payload, its handler's
      // words, any source's key or id, nor the erased source's hash.
      content: [marked, key, person, kept.id, erased.id, subject].filter(
        (each) => text.includes(each)
      ),
      item:
        item === undefined
          ? null
          : { ...item, message: typeof item.message, parkedAt: "set" },
      store: {
        sized: (report?.store.bytes ?? 0) > 0,
        limit: report?.store.limitBytes,
      },
      // No model ships (core's own embedders): none, and nothing embedded.
      embedding: {
        model: report?.embedding.model,
        embedded: report?.embedding.embedded,
      },
      ledger: {
        replay: report?.ledger.replay,
        written: (report?.ledger.source.written ?? 0) > 0,
        deleted: (report?.ledger.byReason.deleted ?? 0) > 0,
      },
      events: brainEvents(events),
    }).toStrictEqual({
      status: 200,
      content: [],
      item: {
        item: id,
        kind: flakyWork.kind,
        attempts: workAttemptsMax,
        parks: 1,
        final: false,
        error: "failed",
        message: "string",
        parkedAt: "set",
      },
      store: { sized: true, limit: 10_000_000_000 },
      embedding: { model: null, embedded: 0 },
      ledger: {
        replay: "through",
        written: true,
        deleted: true,
      },
      events: [{ action: "admin.brain.read", actor: staffActor, detail: {} }],
    });
  });

  it("grows its store's size as content is added", async () => {
    const before = await reported(bytesOf);
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: Array.from({ length: 400 }, () => marker()).join(" "),
      readers: { kind: "owner", personId: "someone" },
    });
    const after = await reported(bytesOf);

    expect(after).toBeGreaterThan(before);
  });
});

describe("the Brain's actions", () => {
  it("puts a parked item back in the queue, where it runs again, and records it", async () => {
    const { key, id } = await parked(marker());
    allowed.add(key);

    const first: unknown[] = [];
    const events = await auditedDuring(async () => {
      first.push(await answerTo({ type: "requeue", item: id }));
    });
    const { report } = await readReport();
    await tick(1);
    const again: unknown[] = [];
    const againEvents = await auditedDuring(async () => {
      again.push(await answerTo({ type: "requeue", item: id }));
    });
    const queued = await brainWorkOverview(env);

    expect({
      first,
      parkedAfter: report?.queue.parked.some((each) => each.item === id),
      waitingAfter: report?.queue.waiting.some(
        ({ kind }) => kind === flakyWork.kind
      ),
      ran: ran.has(key),
      gone: [...queued.parked, ...queued.overdue].some(
        (each) => each.key === key
      ),
      again,
      events: brainEvents(events),
      againEvents: brainEvents(againEvents),
    }).toStrictEqual({
      first: [{ outcome: "done" }],
      parkedAfter: false,
      waitingAfter: true,
      ran: true,
      gone: false,
      again: [{ outcome: "nothing" }],
      // The ask, and what it did.
      events: [
        {
          action: "admin.brain.action.asked",
          actor: staffActor,
          detail: { type: "requeue", item: id },
        },
        {
          action: "admin.brain.action.answered",
          actor: staffActor,
          detail: { type: "requeue", item: id, outcome: "done" },
        },
      ],
      againEvents: [
        {
          action: "admin.brain.action.asked",
          actor: staffActor,
          detail: { type: "requeue", item: id },
        },
        {
          action: "admin.brain.action.answered",
          actor: staffActor,
          detail: { type: "requeue", item: id, outcome: "nothing" },
        },
      ],
    });
  });

  it("rebuilds the word indexes while recall goes on, once at a time, and records it", async () => {
    const marked = marker();
    const person = `person-${crypto.randomUUID()}`;
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `${marked} sits in the warehouse in Rotterdam.`,
      readers: { kind: "owner", personId: person },
    });
    const recalled = async (): Promise<number> => {
      const { items } = await brainOf(
        inJurisdiction(env, env.BRAIN_STORE)
      ).recall({
        question: marked,
        reader: { person, groups: [] },
        budget: { tokens: 1000 },
      });
      return items.length;
    };

    const answers: unknown[] = [];
    const events = await auditedDuring(async () => {
      answers.push(await answerTo({ type: "rebuild_words" }));
    });
    const during = await reported(wordsOf);
    const foundDuring = await recalled();
    const second = await answerTo({ type: "rebuild_words" });
    // A tick rebuilds a batch: enough of them rebuild every chunk here.
    let words = during;
    for (let ticks = 0; ticks < 50 && words === "rebuilding"; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await tick(1);
      // oxlint-disable-next-line no-await-in-loop -- read after each tick
      words = await reported(wordsOf);
    }

    expect({
      answers,
      during,
      foundDuring,
      second,
      words,
      foundAfter: await recalled(),
      events: brainEvents(events),
    }).toStrictEqual({
      answers: [{ outcome: "done" }],
      during: "rebuilding",
      foundDuring: 1,
      second: { outcome: "nothing" },
      words: "current",
      foundAfter: 1,
      events: [
        {
          action: "admin.brain.action.asked",
          actor: staffActor,
          detail: { type: "rebuild_words" },
        },
        {
          action: "admin.brain.action.answered",
          actor: staffActor,
          detail: { type: "rebuild_words", outcome: "done" },
        },
      ],
    });
  });
});

describe("the Brain's actions while it reads its erasure ledger", () => {
  it("applies nothing, answers unavailable, and records the ask with that answer", async () => {
    const { id } = await parked(marker());
    const backup = await copyOfStore();
    await eraseSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      reason: "deleted",
    });
    const last = await runInDurableObject(storeObject(), (_store, state) =>
      state.storage.sql
        .exec<{ key: string }>(
          "SELECT key FROM erasures ORDER BY rowid DESC LIMIT 1"
        )
        .one()
    );
    // An entry it can't read, as a later release's reason would be: the
    // store restored from before it answers nothing but its overview.
    const unknown = `${last.key.slice(0, "erasures/".length + 15)}-source-archived-${await sha256Hex(crypto.randomUUID())}`;
    await env.BRAIN_OBJECTS.put(unknown, "");
    try {
      await restoreStore(backup);
      const answers: unknown[] = [];
      const events = await auditedDuring(async () => {
        answers.push(
          await answerTo({ type: "requeue", item: id }),
          await answerTo({ type: "rebuild_words" }),
          await answerTo({ type: "reembed" })
        );
      });
      const overview = await brainWorkOverview(env);

      expect({
        answers,
        replay: overview.ledgerReplay,
        stillParked: overview.parked.some((item) => item.id === id),
        words: await reported(wordsOf),
        events: brainEvents(events).map(({ action, detail }) => ({
          action,
          detail,
        })),
      }).toStrictEqual({
        answers: [
          { outcome: "unavailable" },
          { outcome: "unavailable" },
          { outcome: "unavailable" },
        ],
        replay: "unreadable",
        stillParked: true,
        words: "current",
        events: [
          {
            action: "admin.brain.action.asked",
            detail: { type: "requeue", item: id },
          },
          {
            action: "admin.brain.action.answered",
            detail: { type: "requeue", item: id, outcome: "unavailable" },
          },
          {
            action: "admin.brain.action.asked",
            detail: { type: "rebuild_words" },
          },
          {
            action: "admin.brain.action.answered",
            detail: { type: "rebuild_words", outcome: "unavailable" },
          },
          { action: "admin.brain.action.asked", detail: { type: "reembed" } },
          {
            action: "admin.brain.action.answered",
            detail: { type: "reembed", outcome: "unavailable" },
          },
        ],
      });
    } finally {
      await env.BRAIN_OBJECTS.delete(unknown);
      await killStore();
    }
  });
});

/**
 * The Brain's store binding, every call of its objects failing, as a store
 * reset in the middle of one would: whether it applied first is unknown.
 */
const throwingStore = (): Env["BRAIN_STORE"] =>
  new Proxy(env.BRAIN_STORE, {
    get: (namespace, name): unknown => {
      if (name === "jurisdiction") {
        return () => throwingStore();
      }
      if (name !== "getByName" && name !== "get") {
        return Reflect.get(namespace, name, namespace);
      }
      return () =>
        new Proxy(
          {},
          {
            get: () => async () =>
              await Promise.reject(new Error("The store was reset")),
          }
        );
    },
  });

describe("the Brain's actions when the store throws", () => {
  it("answers the error and records the ask with a failed answer", async () => {
    // The failed request is logged as an error: that's what it is.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const { status } = await act(
        { type: "rebuild_words" },
        { ...env, BRAIN_STORE: throwingStore() }
      );
      statuses.push(status);
    });
    logged.mockRestore();

    expect({ statuses, events: brainEvents(events) }).toStrictEqual({
      statuses: [500],
      events: [
        {
          action: "admin.brain.action.asked",
          actor: staffActor,
          detail: { type: "rebuild_words" },
        },
        {
          action: "admin.brain.action.answered",
          actor: staffActor,
          detail: { type: "rebuild_words", outcome: "failed" },
        },
      ],
    });
  });
});

/** The host's model, as the store's own tick asks it: it answers, and holds nothing. */
const quietModel = async () => {
  await Promise.resolve();
  return { kind: "answer" as const, text: "" };
};

/** The embed package's int8 test model, run in the test's isolate, as the host's embedders. */
const testModelEmbedders = async (): Promise<Embedders> => {
  const { model } = await embedInProcess([]);
  return {
    model,
    embed: async ({ texts }) => {
      const embedded = await embedInProcess(texts);
      return {
        kind: "vectors",
        model: embedded.model,
        results: embedded.vectors,
      };
    },
  };
};

/**
 * Ticks the store with `embedders` until its rebuild for their model is
 * done, at most 50 ticks; fails saying so past that.
 */
const embedAll = async (embedders: Embedders): Promise<void> => {
  const brain = brainOf(inJurisdiction(env, env.BRAIN_STORE));
  for (let ticks = 0; ticks < 50; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick after another
    await brain.work(quietModel, nextDay(), embedders);
    // oxlint-disable-next-line no-await-in-loop -- look after each tick
    const { embedding } = await brainWorkOverview(env);
    if (embedding.rebuilt) {
      return;
    }
  }
  throw new Error("The rebuild wasn't done after 50 ticks");
};

describe("the Brain's embedding, as staff see it", () => {
  it("counts what its model embedded, with nothing of the content, and re-embeds, during its walk too, each audited", async () => {
    const marked = marker();
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `${marked} is in the contract with the supplier in Utrecht.`,
      readers: { kind: "owner", personId: `person-${crypto.randomUUID()}` },
    });
    const embedders = await testModelEmbedders();
    await embedAll(embedders);

    const read = await readReport();
    const answers: unknown[] = [];
    const events = await auditedDuring(async () => {
      answers.push(
        await answerTo({ type: "reembed" }),
        // The walk it started is under way: a repeat starts it over.
        await answerTo({ type: "reembed" })
      );
    });
    const during = await reported((report) => report?.embedding.rebuilding);
    const { model } = embedders;
    const embedding = read.report?.embedding;

    expect({
      content: read.text.includes(marked),
      embedding:
        embedding === undefined
          ? null
          : {
              model: embedding.model,
              all:
                embedding.embedded + embedding.passedOver === embedding.chunks,
              some: embedding.embedded > 0,
              rebuilding: embedding.rebuilding,
            },
      answers,
      during,
      events: brainEvents(events).map(({ action, detail }) => ({
        action,
        detail,
      })),
    }).toStrictEqual({
      content: false,
      embedding: {
        model: model === null ? null : vectorModelNameOf(model),
        all: true,
        some: true,
        rebuilding: false,
      },
      answers: [{ outcome: "done" }, { outcome: "done" }],
      during: true,
      events: [
        { action: "admin.brain.action.asked", detail: { type: "reembed" } },
        {
          action: "admin.brain.action.answered",
          detail: { type: "reembed", outcome: "done" },
        },
        { action: "admin.brain.action.asked", detail: { type: "reembed" } },
        {
          action: "admin.brain.action.answered",
          detail: { type: "reembed", outcome: "done" },
        },
      ],
    });
  });

  it("clears what its model passed over when staff re-embed while its rebuild is under way", async () => {
    const marked = marker();
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `${marked}\n\nThe second passage, about the warehouse in Assen.`.padEnd(
        2000,
        " filler"
      ),
      readers: { kind: "owner", personId: `person-${crypto.randomUUID()}` },
    });
    const working = await testModelEmbedders();
    // The model passes over the marked passage and embeds nothing else this
    // time: the rebuild stays under way, with something passed over.
    const choosy: Embedders = {
      model: working.model,
      embed: async ({ texts }) => {
        await Promise.resolve();
        return {
          kind: "vectors",
          model: working.model,
          results: texts.map((text) =>
            text.includes(marked) ? "unembeddable" : null
          ),
        };
      },
    };
    const brain = brainOf(inJurisdiction(env, env.BRAIN_STORE));
    await brain.work(quietModel, nextDay(), choosy);
    const before = await reported((report) => report?.embedding);
    const answered = await answerTo({ type: "reembed" });
    const after = await reported((report) => report?.embedding);

    expect({
      before: [(before?.passedOver ?? 0) > 0, before?.rebuilding],
      answered,
      after: [after?.passedOver, after?.rebuilding],
    }).toStrictEqual({
      before: [true, true],
      answered: { outcome: "done" },
      after: [0, true],
    });
  });

  it("mends a rebuild whose items parked while the embedders were broken, once they work again", async () => {
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: "The invoice from the supplier in Zwolle, due in thirty days.",
      readers: { kind: "owner", personId: `person-${crypto.randomUUID()}` },
    });
    const working = await testModelEmbedders();
    const broken: Embedders = {
      model: working.model,
      embed: async () => {
        await Promise.resolve();
        return { kind: "unavailable" };
      },
    };
    const brain = brainOf(inJurisdiction(env, env.BRAIN_STORE));
    // A rebuild under way for the model, its items failing until they park.
    // Each tick is a day after the last, so a parked item also comes back
    // and fails again: ticked until the overview shows one parked, as how
    // many items a tick runs depends on the machine's load, at most 20
    // ticks.
    await brain.work(quietModel, nextDay(), broken);
    await brain.reembed();
    let { embedding: whileBroken } = await brainWorkOverview(env);
    for (let round = 0; round < 20 && whileBroken.parked === 0; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another, past each backoff
      await brain.work(quietModel, nextDay(), broken);
      // oxlint-disable-next-line no-await-in-loop -- looked at after each tick
      ({ embedding: whileBroken } = await brainWorkOverview(env));
    }
    const answered = await answerTo({ type: "reembed" });
    await embedAll(working);
    const { embedding: mended } = await brainWorkOverview(env);

    expect({
      whileBroken: [whileBroken.parked > 0, whileBroken.rebuilt],
      answered,
      mended: [mended.parked, mended.rebuilt],
    }).toStrictEqual({
      whileBroken: [true, false],
      answered: { outcome: "done" },
      mended: [0, true],
    });
  });
});

/**
 * The audit log's binding, taking the first `taken` appends and refusing
 * every one after, as a log that went down in the middle of a request would.
 */
const auditLogFailingAfter = (taken: number): Env["AUDIT_LOG"] => {
  let appends = 0;
  return new Proxy(env.AUDIT_LOG, {
    get: (namespace, name): unknown => {
      if (name !== "getByName" && name !== "get") {
        return Reflect.get(namespace, name, namespace);
      }
      return (id: string) => {
        const log = namespace.getByName(id);
        return new Proxy(log, {
          get: (stub, method): unknown => {
            if (method !== "append") {
              return Reflect.get(stub, method, stub);
            }
            return async (...events: Parameters<typeof log.append>) => {
              appends += 1;
              if (appends > taken) {
                throw new Error("Unavailable");
              }
              return await log.append(...events);
            };
          },
        });
      };
    },
  });
};

describe("the Brain's actions when the log fails after they applied", () => {
  it("answers the error, keeps what was applied, and leaves the ask alone in the log", async () => {
    const { id } = await parked(marker());
    // The failed request is logged as an error: that's what it is.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const { status } = await act(
        { type: "requeue", item: id },
        { ...env, AUDIT_LOG: auditLogFailingAfter(1) }
      );
      statuses.push(status);
    });
    logged.mockRestore();

    expect({
      statuses,
      stillParked: await isParked(id),
      events: brainEvents(events),
    }).toStrictEqual({
      statuses: [500],
      stillParked: false,
      // An ask with no answer: its outcome is unknown.
      events: [
        {
          action: "admin.brain.action.asked",
          actor: staffActor,
          detail: { type: "requeue", item: id },
        },
      ],
    });
  });
});

describe("the Brain's upkeep, as staff see it", () => {
  it("shows an embedding step that failed as a code and a time, never what it failed with", async () => {
    const marked = marker();
    // The store sees the test model first, so core's own tick (no model)
    // changes the model it embeds for, which the step writes.
    await brainOf(inJurisdiction(env, env.BRAIN_STORE)).work(
      quietModel,
      nextDay(),
      await testModelEmbedders()
    );
    // The step's own table refuses every write, with the marker in its words.
    await runInDurableObject(storeObject(), (_store, state) => {
      for (const when of ["INSERT", "UPDATE"]) {
        state.storage.sql.exec(
          `CREATE TRIGGER report_breaks_embedding_${when.toLowerCase()}
          BEFORE ${when} ON embedding_state
          BEGIN SELECT RAISE(ABORT, '${marked}'); END`
        );
      }
    });
    try {
      // Core's embedders run no model, which the store last saw running
      // one: the step writes its state, and fails.
      await workBrain(env, nextDay());
      const { status, text, report } = await readReport();

      expect({
        status,
        failed: report?.stepsFailed.embedding?.reason,
        at: typeof report?.stepsFailed.embedding?.at,
        content: text.includes(marked),
      }).toStrictEqual({
        status: 200,
        failed: "failed",
        at: "string",
        content: false,
      });
    } finally {
      await runInDurableObject(storeObject(), (_store, state) => {
        state.storage.sql.exec(
          "DROP TRIGGER IF EXISTS report_breaks_embedding_insert"
        );
        state.storage.sql.exec(
          "DROP TRIGGER IF EXISTS report_breaks_embedding_update"
        );
      });
    }
  });
});
