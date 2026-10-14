import { signCapability } from "@grasp-os/shared/capability";
import type { CapabilityScope } from "@grasp-os/shared/capability";
import { unknownOutcomeKeySchema } from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  ResolutionChoice,
  UnknownOutcomeKey,
} from "@grasp-os/shared/connect";
import type { Authority } from "@grasp-os/shared/permissions";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  agentFor,
  appFor,
  auditEvents,
  callAs,
  connectAccount,
  originOf,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import { invoices } from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { claimedAgo, parsedRequests, callTool as call } from "./tool-calls.ts";
import type { Connection } from "./tool-calls.ts";

// Calls of unknown outcome resolved by the person they acted for (spec
// 14.3), through connect's real call path against Graph's recorded
// answers. What can go wrong, first: someone else resolves it (another
// person, staff, an ordinary call's capability, one for the other choice);
// a resolution capability used to make a call; "it didn't happen" letting
// the call go twice, or with other input; "it happened" letting it go
// again; a resolution racing a recovery, either way round; and anything
// recorded as undone.

const providers = fakeProviders();
const graph = fakeGraph();
const audit = auditEvents();

/** Someone's Microsoft 365 connection, made through OAuth. */
const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

const email = {
  mailbox: invoices,
  subject: "Payment of invoice 2026-0041",
  body: "Paid today.",
  to: ["billing@northwind.example.org"],
};

/** The writes that reached Graph. */
const writes = () =>
  parsedRequests(graph.sent).filter(
    ({ host, method }) => host === "graph.microsoft.com" && method !== "GET"
  );

const send = async (connection: Connection, key: string, input = email) =>
  await call(connection, "mail.send", input, {
    resource: invoices,
    idempotencyKey: key,
  });

const draft = async (connection: Connection, key: string) =>
  await call(connection, "mail.createDraft", email, {
    resource: invoices,
    idempotencyKey: key,
  });

/** The key of a call `callTool` made for the connection's owner. */
const keyOf = (
  connection: Connection,
  action: string,
  idempotencyKey: string
): UnknownOutcomeKey =>
  unknownOutcomeKeySchema.parse({
    subject: agentFor(connection.person.userId).subject,
    connectionId: connection.id,
    action,
    idempotencyKey,
  });

/**
 * The capability core signs once it checked the call's permission again,
 * resolving it by `choice`, unless `signed` says otherwise.
 */
/** The claim the call under `key` is at now, as its person is shown it. */
const claimOf = async (key: UnknownOutcomeKey): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT claimed_at AS claim FROM idempotent_calls WHERE connection_id = ? AND action = ? AND idempotency_key = ?"
  )
    .bind(key.connectionId, key.action, key.idempotencyKey)
    .first<{ claim: number }>();
  return row?.claim ?? 0;
};

const resolutionCapability = async (
  key: UnknownOutcomeKey,
  choice: ResolutionChoice | undefined,
  authority: Authority,
  extra: Pick<CapabilityScope, "confirms"> & { claim?: number } = {}
): Promise<string> => {
  const { claim = await claimOf(key), ...signed } = extra;
  return await signCapability(env.CAPABILITY_SIGNING_KEY, authority, {
    origin: originOf(authority),
    connectionId: key.connectionId,
    resource: invoices,
    action: key.action,
    idempotencyKey: key.idempotencyKey,
    ...(choice === undefined ? {} : { resolves: { choice, claimedAt: claim } }),
    ...signed,
  });
};

/**
 * Resolves `key` as core does for `person`, at the claim the call is at
 * now unless `claim` says another, with its capability.
 */
const resolve = async (
  person: ConnectionPerson,
  key: UnknownOutcomeKey,
  choice: ResolutionChoice,
  capability?: string,
  claim?: number
): Promise<void> => {
  const at = claim ?? (await claimOf(key));
  await exports.default.resolveOutcome({
    person,
    key,
    choice,
    claim: at,
    capability:
      capability ??
      (await resolutionCapability(key, choice, agentFor(person.userId), {
        claim: at,
      })),
  });
};

const resolutions = async () => {
  const events = await audit.events();
  return events
    .filter(({ action }) => action.startsWith("connection.call.resolve"))
    .map(({ action, actor, detail }) => ({
      action,
      actor,
      choice: detail.choice,
      reason: detail.reason,
    }));
};

/** The resolution events so far, each as its action and reason. */
const recorded = async () => {
  const events = await resolutions();
  return events.map(({ action, reason }) => [action, reason]);
};

/** Whether anything recorded says an effect was undone. */
const undoneRecorded = async () => {
  const events = await audit.events();
  return events.some(({ action }) => /undo|rollback|revert/u.test(action));
};

/** How many calls of unknown outcome are listed for `person`. */
const listedFor = async (person: ConnectionPerson) => {
  const listed = await exports.default.listUnknownOutcomes(person);
  return listed.length;
};

describe("a call of unknown outcome", () => {
  it("is listed for the person it acted for, with what was sent, and for nobody else", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    const lost = await outcome(send(connection, "run-1:send"));
    const listed = await exports.default.listUnknownOutcomes(connection.person);
    const one = await exports.default.unknownOutcome({
      person: connection.person,
      key: keyOf(connection, "mail.send", "run-1:send"),
    });
    expect({
      lost,
      listed,
      same: one,
      others: await exports.default.listUnknownOutcomes(someone()),
      staff: await exports.default.listUnknownOutcomes({
        ...connection.person,
        staff: true,
      }),
    }).toMatchObject({
      lost: "connect.outcome_unknown",
      listed: [
        {
          key: keyOf(connection, "mail.send", "run-1:send"),
          resource: invoices,
          description: { title: "Send an email" },
          input: JSON.stringify(email),
          origin: {
            mode: "workflow",
            appVersion: null,
            permissionId: "permission-mail",
          },
        },
      ],
      same: listed[0],
      others: [],
      staff: [],
    });
  });

  it("resolved as having happened is never sent again: a repeat gets `connect.resolved_done`, with no output", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "run-2:send"));
    const key = keyOf(connection, "mail.send", "run-2:send");
    await resolve(connection.person, key, "happened");
    expect({
      repeats: [
        await outcome(send(connection, "run-2:send")),
        await outcome(send(connection, "run-2:send")),
      ],
      writes: writes().length,
      listed: await exports.default.listUnknownOutcomes(connection.person),
      again: await outcome(resolve(connection.person, key, "not_happened")),
      resolutions: await resolutions(),
      undone: await undoneRecorded(),
    }).toStrictEqual({
      repeats: ["connect.resolved_done", "connect.resolved_done"],
      writes: 1,
      listed: [],
      // Resolved once: its person's word stands.
      again: "connect.outcome_not_found",
      resolutions: [
        {
          action: "connection.call.resolved",
          actor: { type: "person", userId: connection.person.userId },
          choice: "happened",
          reason: undefined,
        },
        {
          action: "connection.call.resolve_refused",
          actor: { type: "person", userId: connection.person.userId },
          choice: "not_happened",
          reason: "connect.outcome_not_found",
        },
      ],
      undone: false,
    });
  });

  it("resolved as not having happened is sent exactly once more, with the same input, by one of two calls racing", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "run-3:send"));
    await resolve(
      connection.person,
      keyOf(connection, "mail.send", "run-3:send"),
      "not_happened"
    );
    const other = await outcome(
      send(connection, "run-3:send", { ...email, subject: "Something else" })
    );
    const raced = await Promise.all([
      outcome(send(connection, "run-3:send")),
      outcome(send(connection, "run-3:send")),
    ]);
    expect({
      other,
      sent: raced.filter((ended) => ended === "ok").length,
      others: raced.filter((ended) => ended !== "ok"),
      // Answered from then on.
      repeat: await outcome(send(connection, "run-3:send")),
      writes: writes().length,
      resolutions: await resolutions(),
    }).toStrictEqual({
      other: "connect.idempotency_conflict",
      sent: 1,
      others: ["connect.call_in_progress"],
      repeat: "ok",
      writes: 2,
      resolutions: [
        {
          action: "connection.call.resolved",
          actor: { type: "person", userId: connection.person.userId },
          choice: "not_happened",
          reason: undefined,
        },
      ],
    });
  });

  it("is resolved by nobody but the person it acted for, with core's resolution of exactly it, and every refusal is recorded", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "run-4:send"));
    const key = keyOf(connection, "mail.send", "run-4:send");
    const owner = agentFor(connection.person.userId);
    const stranger = someone();
    const refused = {
      // Another person, with a capability signed for them.
      stranger: await outcome(resolve(stranger, key, "not_happened")),
      // Grasp staff, as the person.
      staff: await outcome(
        resolve({ ...connection.person, staff: true }, key, "not_happened")
      ),
      // A capability for an ordinary call, not a resolution.
      ordinary: await outcome(
        resolve(
          connection.person,
          key,
          "not_happened",
          await resolutionCapability(key, undefined, owner)
        )
      ),
      // Resolving it the other way than core signed.
      otherChoice: await outcome(
        resolve(
          connection.person,
          key,
          "not_happened",
          await resolutionCapability(key, "happened", owner)
        )
      ),
      // Another App or agent's call under the key.
      otherSubject: await outcome(
        resolve(
          connection.person,
          key,
          "not_happened",
          await resolutionCapability(
            key,
            "not_happened",
            agentFor(connection.person.userId, "agent-other")
          )
        )
      ),
      // A resolution's capability, used to make the call.
      asCall: await outcome(
        callAs(
          owner,
          {
            connectionId: connection.id,
            resource: invoices,
            action: "mail.send",
            input: email,
            idempotencyKey: "run-4:send",
          },
          {
            resolves: {
              choice: "not_happened",
              claimedAt: await claimOf(key),
            },
          }
        )
      ),
      asHeldOutcome: await outcome(
        exports.default.heldOutcome({
          connectionId: connection.id,
          resource: invoices,
          action: "mail.send",
          idempotencyKey: "run-4:send",
          capability: await resolutionCapability(key, "not_happened", owner),
        })
      ),
    };
    expect({
      refused,
      writes: writes().length,
      stillListed: await listedFor(connection.person),
      recorded: await recorded(),
    }).toStrictEqual({
      refused: {
        stranger: "connect.outcome_not_found",
        staff: "connect.outcome_not_found",
        ordinary: "capability.invalid",
        otherChoice: "capability.invalid",
        otherSubject: "capability.invalid",
        asCall: "capability.invalid",
        asHeldOutcome: "capability.invalid",
      },
      writes: 1,
      stillListed: 1,
      recorded: [
        ["connection.call.resolve_refused", "connect.outcome_not_found"],
        ["connection.call.resolve_refused", "connect.outcome_not_found"],
        ["connection.call.resolve_refused", "capability.invalid"],
        ["connection.call.resolve_refused", "capability.invalid"],
        ["connection.call.resolve_refused", "capability.invalid"],
      ],
    });
  });

  it("isn't resolved once a recovery took it up since it was read, and a recovery that read it before a resolution doesn't go out", async () => {
    const connection = await connected();
    // A draft, which connect recovers by looking it up.
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-5:draft"));
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-5:other"));
    await claimedAgo(connection);
    // The recovery runs between the resolution's read and its write.
    const batch = env.DB.batch.bind(env.DB);
    let recovered: string | undefined;
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      recovered = await outcome(draft(connection, "run-5:draft"));
      return await batch(statements);
    });
    const lateResolution = await outcome(
      resolve(
        connection.person,
        keyOf(connection, "mail.createDraft", "run-5:draft"),
        "happened"
      )
    );
    vi.restoreAllMocks();
    // The resolution lands between the recovery's read and its retake.
    const prepare = env.DB.prepare.bind(env.DB);
    let resolved: string | undefined;
    const resolving = async (): Promise<void> => {
      resolved ??= await outcome(
        resolve(
          connection.person,
          keyOf(connection, "mail.createDraft", "run-5:other"),
          "happened"
        )
      );
    };
    /** The statement, its every method waiting for the resolution first. */
    const delayed = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== "function") {
            return value;
          }
          if (property === "bind") {
            return (...values: unknown[]) => delayed(target.bind(...values));
          }
          return async (...values: unknown[]): Promise<unknown> => {
            await resolving();
            const result: unknown = await Reflect.apply(value, target, values);
            return result;
          };
        },
      });
    let first = true;
    vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (!first || !query.startsWith('update "idempotent_calls"')) {
        return statement;
      }
      first = false;
      return delayed(statement);
    });
    const lateRecovery = await outcome(draft(connection, "run-5:other"));
    vi.restoreAllMocks();
    expect({
      recovered,
      lateResolution,
      resolved,
      lateRecovery,
      repeat: await outcome(draft(connection, "run-5:other")),
      // The two lost writes; nothing made again.
      writes: writes().length,
      recorded: await recorded(),
    }).toStrictEqual({
      recovered: "ok",
      lateResolution: "connect.outcome_not_found",
      resolved: "ok",
      lateRecovery: "connect.call_in_progress",
      repeat: "connect.resolved_done",
      writes: 2,
      recorded: [
        ["connection.call.resolve_refused", "connect.outcome_not_found"],
        ["connection.call.resolved", undefined],
      ],
    });
  });

  it("holds a run's step while unresolved and connect can't recover it now, and no longer once resolved or recoverable", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "run-6:send"));
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-6:draft"));
    const pending = async (idempotencyKey: string) =>
      await exports.default.anyPending({
        onBehalfOf: connection.person.userId,
        idempotencyKey,
      });
    const before = {
      email: await pending("run-6:send"),
      // Its call may still be out: not yet recoverable.
      draft: await pending("run-6:draft"),
      otherPerson: await exports.default.anyPending({
        onBehalfOf: someone().userId,
        idempotencyKey: "run-6:send",
      }),
    };
    await claimedAgo(connection);
    const recoverable = await pending("run-6:draft");
    await resolve(
      connection.person,
      keyOf(connection, "mail.send", "run-6:send"),
      "happened"
    );
    expect({
      before,
      recoverable,
      resolved: await pending("run-6:send"),
    }).toStrictEqual({
      before: { email: true, draft: true, otherPerson: false },
      recoverable: false,
      resolved: false,
    });
  });
});

/** The details of the error `promise` failed with. */
const detailsOf = async (
  promise: Promise<unknown>
): Promise<Record<string, unknown>> => {
  try {
    await promise;
  } catch (error) {
    return (
      z
        .object({ details: z.record(z.string(), z.unknown()).optional() })
        .parse(error).details ?? {}
    );
  }
  throw new Error("The call didn't fail");
};

/** The binding an App's call came through, as core signs it. */
const binding = {
  id: "binding-mail",
  declarationHash: "a".repeat(64),
  fingerprint: "b".repeat(64),
};

describe("a native connector's call of unknown outcome", () => {
  it("says a run waits on it for its person to resolve, whenever it is asked", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    expect({
      first: await detailsOf(send(connection, "run-8:send")),
      repeat: await detailsOf(send(connection, "run-8:send")),
    }).toStrictEqual({
      first: { awaitsResolution: true },
      repeat: { awaitsResolution: true },
    });
  });

  it("refused recovery for the confirmation it needs now, keeps a run waiting rather than tell it to run again", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-9:draft"));
    await claimedAgo(connection);
    const pending = async () =>
      await exports.default.anyPending({
        onBehalfOf: connection.person.userId,
        idempotencyKey: "run-9:draft",
      });
    const recoverable = await pending();
    // Its context has read restricted data since: its person must confirm.
    const restricted = await outcome(
      callAs(
        agentFor(connection.person.userId),
        {
          connectionId: connection.id,
          resource: invoices,
          action: "mail.createDraft",
          input: email,
          idempotencyKey: "run-9:draft",
        },
        { restricted: true }
      )
    );
    expect({
      recoverable,
      restricted,
      after: await pending(),
      writes: writes().length,
    }).toStrictEqual({
      recoverable: false,
      restricted: "connect.outcome_unknown",
      after: true,
      writes: 1,
    });
  });

  it("keeps no input past the retention of answers, whoever made it, and stays listed", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "chat-1:send"));
    await env.DB.prepare(
      "UPDATE idempotent_calls SET created_at = created_at - ?1, claimed_at = claimed_at - ?1 WHERE connection_id = ?2"
    )
      .bind(31 * 24 * 60 * 60 * 1000, connection.id)
      .run();
    const before = await exports.default.listUnknownOutcomes(connection.person);
    // Any later claim sweeps it, as it sweeps expired answers.
    await outcome(send(connection, "chat-2:send"));
    const after = await exports.default.listUnknownOutcomes(connection.person);
    expect({
      before: before.map(({ input }) => input),
      after: after.map(({ input }) => input),
    }).toStrictEqual({ before: [JSON.stringify(email)], after: [null] });
  });

  it("keeps the resource binding its call came through, for core to check before it signs a resolution", async () => {
    const connection = await connected();
    const app = appFor(connection.person.userId);
    graph.loseWriteAnswer();
    await outcome(
      callAs(
        app,
        {
          connectionId: connection.id,
          resource: invoices,
          action: "mail.send",
          input: email,
          idempotencyKey: "run-10:send",
        },
        { origin: { ...originOf(app), binding } }
      )
    );
    const [listed] = await exports.default.listUnknownOutcomes(
      connection.person
    );
    expect(listed?.origin).toStrictEqual({
      mode: "workflow",
      appVersion: 1,
      permissionId: "permission-mail",
      context: { type: "app", appId: "app-crm" },
      binding,
    });
  });

  it("refuses, without recording anything, a resolution of a call never made, and refuses one that also confirms, or names another person", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "run-11:send"));
    const key = keyOf(connection, "mail.send", "run-11:send");
    const owner = agentFor(connection.person.userId);
    const never = await outcome(
      resolve(
        connection.person,
        keyOf(connection, "mail.send", "run-11:never"),
        "happened"
      )
    );
    const recordedForNever = await recorded();
    const refused = {
      confirmsToo: await outcome(
        resolve(
          connection.person,
          key,
          "happened",
          await resolutionCapability(key, "happened", owner, {
            confirms: crypto.randomUUID(),
          })
        )
      ),
      otherPerson: await outcome(
        resolve(
          connection.person,
          key,
          "happened",
          await resolutionCapability(
            key,
            "happened",
            agentFor(someone().userId)
          )
        )
      ),
    };
    expect({
      never,
      recordedForNever,
      refused,
      recorded: await recorded(),
      stillListed: await listedFor(connection.person),
    }).toStrictEqual({
      never: "connect.outcome_not_found",
      recordedForNever: [],
      refused: {
        confirmsToo: "capability.invalid",
        otherPerson: "capability.invalid",
      },
      recorded: [
        ["connection.call.resolve_refused", "capability.invalid"],
        ["connection.call.resolve_refused", "capability.invalid"],
      ],
      stillListed: 1,
    });
  });
});

describe("two resolutions that it didn't happen, at once", () => {
  it("let it be sent once more, never twice, even when that send is lost again", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "run-12:send"));
    const key = keyOf(connection, "mail.send", "run-12:send");
    // Both read, and signed for, the claim the person was shown.
    const shown = await claimOf(key);
    const capabilities = await Promise.all([
      resolutionCapability(
        key,
        "not_happened",
        agentFor(connection.person.userId),
        {
          claim: shown,
        }
      ),
      resolutionCapability(
        key,
        "not_happened",
        agentFor(connection.person.userId),
        {
          claim: shown,
        }
      ),
    ]);
    const first = await outcome(
      resolve(connection.person, key, "not_happened", capabilities[0], shown)
    );
    // Its one more send is lost again: a new claim, of unknown outcome.
    graph.loseWriteAnswer();
    const resent = await outcome(send(connection, "run-12:send"));
    // The second, late, finds the claim it was signed for gone.
    const second = await outcome(
      resolve(connection.person, key, "not_happened", capabilities[1], shown)
    );
    expect({
      first,
      resent,
      second,
      again: await outcome(send(connection, "run-12:send")),
      writes: writes().length,
    }).toStrictEqual({
      first: "ok",
      resent: "connect.outcome_unknown",
      second: "connect.outcome_not_found",
      again: "connect.outcome_unknown",
      // The first send and the one more it was let go: no third.
      writes: 2,
    });
  });
});

describe("a native connector's call whose audit couldn't be recorded", () => {
  it("says a run waits on it for its person to resolve, as any lost answer", async () => {
    const connection = await connected();
    // The call's second batch is its answer with its audit events: it
    // fails, after Graph sent the mail.
    const batch = env.DB.batch.bind(env.DB);
    let batches = 0;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      batches += 1;
      if (batches === 2) {
        throw new Error("D1 is unavailable");
      }
      return await batch(statements);
    });
    const failed = await detailsOf(send(connection, "run-13:send"));
    vi.restoreAllMocks();
    expect({
      failed,
      repeat: await outcome(send(connection, "run-13:send")),
      writes: writes().length,
    }).toStrictEqual({
      failed: { awaitsResolution: true },
      repeat: "connect.outcome_unknown",
      writes: 1,
    });
  });
});

describe("a run's step key with many calls of unknown outcome", () => {
  it("waits while any of them waits for its person, however many come before it", async () => {
    const connection = await connected();
    // A draft connect may recover now, under the step's key...
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-14:step"));
    await claimedAgo(connection);
    const columns = await env.DB.prepare("PRAGMA table_info(connections)").all<{
      name: string;
    }>();
    const names = columns.results.map(({ name }) => name);
    const copies = Array.from(
      { length: 11 },
      () => `connection-${crypto.randomUUID()}`
    );
    // ...the same on ten more connections, and, last, an email nothing
    // recovers, all under it.
    for (const [index, copy] of copies.entries()) {
      const action =
        index === copies.length - 1 ? "mail.send" : "mail.createDraft";
      // oxlint-disable-next-line no-await-in-loop -- in order: the email last
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO connections (${names.join(", ")}) SELECT ${names.map((name) => (name === "id" || name === "account_id" ? "?1" : name)).join(", ")} FROM connections WHERE id = ?2`
        ).bind(copy, connection.id),
        env.DB.prepare(
          "INSERT INTO idempotent_calls (subject_type, subject_id, on_behalf_of, connection_id, action, idempotency_key, input_hash, state, output, provenance, created_at, claimed_at, connector_version, resource, input, origin) SELECT subject_type, subject_id, on_behalf_of, ?1, ?2, idempotency_key, input_hash, state, output, provenance, created_at, claimed_at, connector_version, resource, input, origin FROM idempotent_calls WHERE connection_id = ?3"
        ).bind(copy, action, connection.id),
      ]);
    }
    await expect(
      exports.default.anyPending({
        onBehalfOf: connection.person.userId,
        idempotencyKey: "run-14:step",
      })
    ).resolves.toBeTruthy();
  });
});
