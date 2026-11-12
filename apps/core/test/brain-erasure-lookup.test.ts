import {
  brainActionPurpose,
  brainErasureAnswerSchema,
  brainErasurePath,
  brainErasurePurpose,
  brainReportPurpose,
} from "@grasp-os/shared/brain-report";
import type {
  BrainErasureAnswer,
  BrainErasureLookup,
} from "@grasp-os/shared/brain-report";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  addSource,
  eraseSource,
  erasePerson,
  workBrain,
} from "../src/brain-next.ts";
import { personErasureAreas } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { retryErasures } from "../src/person-erasure.ts";
import {
  copyOfStore,
  killStore,
  restoreStore,
} from "./brain-next-store-copy.ts";
import { failingAuditLog } from "./failing-audit-log.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
import {
  auditedDuring,
  routed,
  signedInApi,
  signedInWithRole,
} from "./sign-in.ts";

// Grasp's staff asking whether a source or a person was erased from this
// client's Brain (src/brain-report.ts `brainErasureResponse`), as the
// admin asks: through the router, signed for the lookup's own purpose,
// naming the staff member. The ways it can fail, from its threat model
// (GRA-1818), tried first:
//
// - Anyone but the admin asking: unsigned, with a member's session, or
//   signed with the admin's key for the report or the actions.
// - A lookup the company can't see in its audit log, or one answered when
//   the log can't take it; an event or an answer holding the key, the id
//   or the hash the ledger names it by.
// - "Not erased" telling something that exists from something that never
//   did.
// - "Erased" said of an erasure whose ledger entry isn't written yet, or
//   "not erased" while the store replays its ledger after a restore.

const idp = mockIdp();

/** The Grasp staff member the admin says is asking. */
const staffEmail = "grace.hopper@grasp.test";
const staffActor = { type: "staff", userId: staffEmail, via: "console" };

/** The Brain's one store, as the tests reach into it. */
const storeObject = () =>
  inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** Words nobody else uses, to look for where they must not be. */
const marker = () => `Quokka${crypto.randomUUID().replaceAll("-", "")}`;

/** `body`'s signature as the admin makes it, for `purpose`. */
const signatureOf = async (
  body: string,
  purpose = brainErasurePurpose
): Promise<string> => {
  const key = await hkdfHmacKey(env.BETTER_AUTH_SECRET, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** A lookup's body, as the admin sends it: now, for `staffEmail`. */
const bodyOf = (lookup: BrainErasureLookup): string =>
  JSON.stringify({
    sentAt: new Date().toISOString(),
    staff: { email: staffEmail },
    lookup,
  });

/** Posts `body` through the router, as given. */
const post = async (
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
    brainErasurePath,
    { method, headers, ...(method === "POST" ? { body } : {}) },
    coreEnv
  );
};

/** Looks up as the admin does: the status, the answer's text and what it says. */
const lookUp = async (
  lookup: BrainErasureLookup,
  coreEnv: Env = env
): Promise<{
  status: number;
  text: string;
  answer: BrainErasureAnswer | null;
}> => {
  const body = bodyOf(lookup);
  const response = await post(body, {
    signature: await signatureOf(body),
    coreEnv,
  });
  const text = await response.text();
  const parsed = brainErasureAnswerSchema.safeParse(
    response.ok ? JSON.parse(text) : null
  );
  return {
    status: response.status,
    text,
    answer: parsed.success ? parsed.data : null,
  };
};

/** What a lookup answered alone. */
const answerTo = async (lookup: BrainErasureLookup) => {
  const { answer } = await lookUp(lookup);
  return answer;
};

/** A lookup's text alone. */
const textOf = async (lookup: BrainErasureLookup) => {
  const { text } = await lookUp(lookup);
  return text;
};

/** The lookups among `events`: action, actor and detail. */
const lookups = (
  events: readonly { action: string; actor: unknown; detail?: unknown }[]
) =>
  events
    .filter(({ action }) => action === "admin.brain.erasure.looked_up")
    .map(({ action, actor, detail }) => ({ action, actor, detail }));

/** A source of `person`'s alone holding `text`. */
const ownSource = async (person: string, text: string) => {
  const source = { producer: "upload" as const, id: crypto.randomUUID() };
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers: { kind: "owner", personId: person },
  });
  return source;
};

/** Runs `run` while every write of the store to its bucket fails; its bucket is back after. */
const bucketPutsFailingDuring = async (
  run: () => Promise<void>
): Promise<void> => {
  const objectEnv = await runInDurableObject(storeObject(), (instance) => {
    const own: unknown = Reflect.get(instance, "env");
    if (typeof own !== "object" || own === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    Reflect.set(instance, "env", {
      ...own,
      BRAIN_OBJECTS: {
        get: async (key: string) => await bucket.get(key),
        list: async (options: R2ListOptions) => await bucket.list(options),
        delete: async (keys: string | string[]) => {
          await bucket.delete(keys);
        },
        put: async () => await Promise.reject(new Error("R2 is down")),
      },
    });
    return own;
  });
  try {
    await run();
  } finally {
    await runInDurableObject(storeObject(), (instance) => {
      Reflect.set(instance, "env", objectEnv);
    });
  }
};

describe("who may ask whether something was erased", () => {
  it("refuses anyone but the admin, and records nothing", async () => {
    const member = await signedInWithRole(idp, "user");
    const body = bodyOf({ kind: "person", id: crypto.randomUUID() });
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const responses = await Promise.all([
        post(body),
        post(body, { signature: "0".repeat(64) }),
        post(body, { cookie: member.session }),
        // The admin's keys for the report and the actions sign no lookup.
        post(body, { signature: await signatureOf(body, brainReportPurpose) }),
        post(body, { signature: await signatureOf(body, brainActionPurpose) }),
        post(body, { signature: await signatureOf(body), method: "GET" }),
        // Signed, but asking for a list rather than naming one thing.
        post(JSON.stringify({ ...JSON.parse(body), lookup: { kind: "all" } }), {
          signature: await signatureOf(
            JSON.stringify({ ...JSON.parse(body), lookup: { kind: "all" } })
          ),
        }),
      ]);
      statuses.push(...responses.map(({ status }) => status));
      await Promise.all(responses.map(async (each) => await each.text()));
    });

    expect({ statuses, events: lookups(events) }).toStrictEqual({
      statuses: [401, 401, 401, 401, 401, 404, 403],
      events: [],
    });
  });

  it("answers nothing when the audit log can't take the lookup", async () => {
    const person = `person-${crypto.randomUUID()}`;
    await ownSource(person, `${marker()} is the plan.`);
    await erasePerson(env, { personId: person, reason: "person_erased" });
    // The failed request is logged as an error: that's what it is.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const { status, text } = await lookUp(
      { kind: "person", id: person },
      { ...env, AUDIT_LOG: failingAuditLog() }
    );
    logged.mockRestore();

    expect({ status, erased: text.includes("erased") }).toStrictEqual({
      status: 500,
      erased: false,
    });
  });
});

describe("whether something was erased", () => {
  it("says a source and a withdrawn person were erased, with when, recording each lookup without the key, the id or their hash", async () => {
    const marked = marker();
    const person = `person-${marked}`;
    const source = await ownSource(`someone-${marked}`, `${marked} is kept.`);
    await ownSource(person, `${marked} is theirs.`);
    const before = Date.now();
    await eraseSource(env, { source, reason: "deleted" });
    // A withdrawal: the shared store's alone, with no erasure in core's own
    // record, so the ledger's answer is the answer.
    await erasePerson(env, { personId: person, reason: "withdrawn" });
    const after = Date.now();
    const key = `upload:${source.id}`;

    const answers: Awaited<ReturnType<typeof lookUp>>[] = [];
    const events = await auditedDuring(async () => {
      answers.push(
        await lookUp({ kind: "source", key }),
        await lookUp({ kind: "person", id: person })
      );
    });
    const hashes = [await sha256Hex(key), await sha256Hex(person)];
    const said = JSON.stringify({ answers, events });

    expect({
      states: answers.map(({ answer }) => answer?.state),
      when: answers.map(({ answer }) => {
        const at = answer?.state === "erased" ? Date.parse(answer.at) : 0;
        return at >= before - 1000 && at <= after + 1000;
      }),
      leaked: [marked, source.id, ...hashes].filter((each) =>
        said.includes(each)
      ),
      events: lookups(events),
    }).toStrictEqual({
      states: ["erased", "erased"],
      when: [true, true],
      leaked: [],
      events: [
        {
          action: "admin.brain.erasure.looked_up",
          actor: staffActor,
          detail: { kind: "source", outcome: "erased" },
        },
        {
          action: "admin.brain.erasure.looked_up",
          actor: staffActor,
          detail: { kind: "person", outcome: "erased" },
        },
      ],
    });
  });

  it("answers what was never erased exactly as what never existed", async () => {
    const person = `person-${crypto.randomUUID()}`;
    const kept = await ownSource(person, `${marker()} is kept.`);

    const texts = [
      await textOf({ kind: "source", key: `upload:${kept.id}` }),
      await textOf({ kind: "source", key: `upload:${crypto.randomUUID()}` }),
      await textOf({ kind: "person", id: person }),
      await textOf({ kind: "person", id: crypto.randomUUID() }),
    ];

    expect(texts).toStrictEqual(
      Array.from({ length: 4 }, () => JSON.stringify({ state: "not_erased" }))
    );
  });

  it("says an erasure whose ledger entry isn't written yet isn't finished, and erased once a tick wrote it", async () => {
    const person = `person-${crypto.randomUUID()}`;
    const source = await ownSource(person, `${marker()} is to go.`);
    await bucketPutsFailingDuring(async () => {
      await expect(
        eraseSource(env, { source, reason: "deleted" })
      ).rejects.toThrow("The Brain could not record the erasure");
    });
    const lookup = { kind: "source", key: `upload:${source.id}` } as const;
    const unwritten = await answerTo(lookup);
    await workBrain(env, new Date(), noProducers);
    const written = await answerTo(lookup);

    expect({
      unwritten,
      written: written?.state,
    }).toStrictEqual({
      unwritten: { state: "erasing" },
      written: "erased",
    });
  });
});

/** Whether `name` is the shared store's, the only one staff may address. */
const isShared = (name: string): boolean => name === "brain";

/**
 * The Brain's store binding, each store it is asked for by name, or by an
 * id made from one, recorded in `addressed`: the shared store is `brain`,
 * a person's own `person:<id>`. An id handed over ready-made is recorded
 * as `(id)`, which no shared lookup uses.
 */
const recordingStore = (addressed: string[]): Env["BRAIN_STORE"] =>
  new Proxy(env.BRAIN_STORE, {
    get: (namespace, member): unknown => {
      if (member === "jurisdiction") {
        return () => recordingStore(addressed);
      }
      const value: unknown = Reflect.get(namespace, member, namespace);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => {
        if (member === "getByName" || member === "idFromName") {
          addressed.push(String(args[0]));
        } else if (member === "get") {
          addressed.push("(id)");
        }
        return Reflect.apply(value, namespace, args);
      };
    },
  });

describe("whether a person was erased, as core's own record and the shared ledger say", () => {
  it("says an erasure of a person not finished while core's erasure of them from the Brain is pending, and erased once it is complete", async () => {
    const admin = await signedInApi(idp, "admin");
    const erased = await signedInApi(idp, "builder");
    await ownSource(erased.userId, `${marker()} is theirs.`);
    await admin.api.members.remove(erased.userId);
    // The Brain can't write its ledger: core's area for it stays pending.
    await bucketPutsFailingDuring(async () => {
      await Promise.allSettled([
        admin.api.members.erase(erased.userId, String(erased.person.name)),
      ]);
    });
    const lookup = { kind: "person", id: erased.userId } as const;
    const pending = await answerTo(lookup);
    // The Brain's tick writes the entry: its ledger has it, core not yet.
    await workBrain(env, new Date(), noProducers);
    const ledgerOnly = await answerTo(lookup);
    // Core's clock asks the Brain again, which returns: the area is complete.
    await retryErasures(env);
    const complete = await answerTo(lookup);

    expect({
      pending,
      ledgerOnly,
      complete: complete?.state,
    }).toStrictEqual({
      pending: { state: "erasing" },
      ledgerOnly: { state: "erasing" },
      complete: "erased",
    });
  });

  it("never addresses a person's own store, for a person or a source", async () => {
    const addressed: string[] = [];
    const person = `person-${crypto.randomUUID()}`;
    const source = await ownSource(person, `${marker()} is theirs.`);
    await erasePerson(env, { personId: person, reason: "withdrawn" });
    const coreEnv = { ...env, BRAIN_STORE: recordingStore(addressed) };

    const ofPerson = await lookUp({ kind: "person", id: person }, coreEnv);
    const ofSource = await lookUp(
      { kind: "source", key: `upload:${source.id}` },
      coreEnv
    );
    const answers = [ofPerson.status, ofSource.status];

    expect({
      answers,
      personal: addressed.filter((name) => !isShared(name)),
      shared: addressed.some(isShared),
    }).toStrictEqual({ answers: [200, 200], personal: [], shared: true });
  });
});

/** Runs `run` while the store can delete no version: each batch an erasure deletes fails. */
const deletesFailingDuring = async (
  run: () => Promise<void>
): Promise<void> => {
  const trigger = "erasure_lookup_test_holds_versions";
  await runInDurableObject(storeObject(), (_store, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER ${trigger} BEFORE DELETE ON source_versions
      BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
    );
  });
  try {
    await run();
  } finally {
    await runInDurableObject(storeObject(), (_store, state) => {
      state.storage.sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    });
  }
};

describe("whether something was erased, while its versions wait to be deleted", () => {
  it("says an erasure in the ledger isn't finished while versions it hid are still kept, and erased once a tick deleted them", async () => {
    const source = await ownSource(
      `person-${crypto.randomUUID()}`,
      `${marker()} is to go.`
    );
    const lookup = { kind: "source", key: `upload:${source.id}` } as const;
    let waiting: unknown = null;
    await deletesFailingDuring(async () => {
      // The entry is written and the erasure returns; its own batch fails.
      await eraseSource(env, { source, reason: "deleted" });
      waiting = await answerTo(lookup);
    });
    await workBrain(env, new Date(), noProducers);
    const deleted = await answerTo(lookup);

    expect({ waiting, deleted: deleted?.state }).toStrictEqual({
      waiting: { state: "erasing" },
      deleted: "erased",
    });
  });
});

/**
 * The Brain's store binding, every call of its objects failing, as a store
 * reset in the middle of one would.
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

describe("whether something was erased, when a read fails", () => {
  it("answers the error and records the lookup as failed, when the store throws or core's record can't be read as done or under way", async () => {
    const admin = await signedInApi(idp, "admin");
    const erased = await signedInApi(idp, "builder");
    await admin.api.members.remove(erased.userId);
    await admin.api.members.erase(erased.userId, String(erased.person.name));
    // An area no step skips, skipped: neither done nor under way.
    await drizzle(env.DB)
      .update(personErasureAreas)
      .set({ state: "skipped" })
      .where(
        and(
          eq(personErasureAreas.userId, erased.userId),
          eq(personErasureAreas.area, "brain_sources")
        )
      );
    // The failed requests are logged as errors: that's what they are.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const ofStore = await lookUp(
        { kind: "source", key: `upload:${crypto.randomUUID()}` },
        { ...env, BRAIN_STORE: throwingStore() }
      );
      const ofRecord = await lookUp({ kind: "person", id: erased.userId });
      statuses.push(ofStore.status, ofRecord.status);
    });
    logged.mockRestore();

    expect({
      statuses,
      events: lookups(events).map(({ detail }) => detail),
    }).toStrictEqual({
      statuses: [500, 500],
      events: [
        { kind: "source", outcome: "failed" },
        { kind: "person", outcome: "failed" },
      ],
    });
  });
});

describe("whether something was erased, while the Brain reads its ledger", () => {
  it("answers unavailable, never not erased, and records that", async () => {
    const backup = await copyOfStore();
    const person = `person-${crypto.randomUUID()}`;
    await ownSource(person, `${marker()} is theirs.`);
    await erasePerson(env, { personId: person, reason: "withdrawn" });
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
        answers.push(await answerTo({ kind: "person", id: person }));
      });

      expect({
        answers,
        events: lookups(events).map(({ detail }) => detail),
      }).toStrictEqual({
        answers: [{ state: "unavailable" }],
        events: [{ kind: "person", outcome: "unavailable" }],
      });
    } finally {
      await env.BRAIN_OBJECTS.delete(unknown);
      await killStore();
    }
  });
});
