import { effectKeyPattern } from "@grasp-os/connector-kit/manifest";
import { effectPropertyId } from "@grasp-os/connector-microsoft-365/graph";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  agentFor,
  auditEvents,
  callAs,
  connectAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import { invoices } from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  parsedRequests,
  retryable,
} from "./tool-calls.ts";
import type { Connection } from "./tool-calls.ts";

// Recovering a native connector's side effect of unknown outcome (spec
// 14.3), through connect's real call path against Graph's recorded
// answers: a Microsoft 365 draft is looked up by the effect key it carries
// (`find`) before anything is made again; an email isn't recovered at all.
// What can go wrong, first: a recovery racing the call it recovers or
// another recovery, a lookup that failed read as "absent", a caller who
// may no longer act or must confirm, other input under the key, a lookup
// beyond the call's own mailbox, an effect too old to touch or claimed by
// another connector release, and a late call clobbering a newer claim.

const providers = fakeProviders();
const graph = fakeGraph();
const audit = auditEvents();

const claimTimeoutMs = 5 * 60 * 1000;

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

/** The requests that reached Graph, parsed. */
const requests = () =>
  parsedRequests(graph.sent).filter(
    ({ host }) => host === "graph.microsoft.com"
  );

const writes = () => requests().filter(({ method }) => method !== "GET");
const lookups = () =>
  requests().filter(({ query }) => query.$filter !== undefined);

const tagSchema = z.object({
  singleValueExtendedProperties: z.array(
    z.object({ id: z.string(), value: z.string() })
  ),
});

/** The effect key a write tagged its message with. */
const tagOf = (body: unknown): string | undefined => {
  const message = z.object({ message: z.unknown() }).safeParse(body).data;
  return tagSchema
    .safeParse(message?.message ?? body)
    .data?.singleValueExtendedProperties.find(
      ({ id }) => id === effectPropertyId
    )?.value;
};

const send = async (connection: Connection, key: string) =>
  await call(connection, "mail.send", email, {
    resource: invoices,
    idempotencyKey: key,
  });

const draft = async (connection: Connection, key: string) =>
  await call(connection, "mail.createDraft", email, {
    resource: invoices,
    idempotencyKey: key,
  });

/** The state of the connection's stored calls. */
const statesOf = async ({ id }: Connection): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT state FROM idempotent_calls WHERE connection_id = ?"
  )
    .bind(id)
    .all<{ state: string }>();
  return results.map(({ state }) => state);
};

/** One column of the connection's stored calls. */
const columnOf = async (
  { id }: Connection,
  column: "claimed_at" | "connector_version"
): Promise<unknown[]> => {
  const { results } = await env.DB.prepare(
    `SELECT ${column} AS value FROM idempotent_calls WHERE connection_id = ?`
  )
    .bind(id)
    .all<{ value: unknown }>();
  return results.map(({ value }) => value);
};

/**
 * Has `meanwhile` run right before the `nth` read of a stored call from
 * now on reaches the database: as another call writing between two reads.
 */
const beforeRead = (nth: number, meanwhile: () => Promise<unknown>): void => {
  const prepare = env.DB.prepare.bind(env.DB);
  let reads = 0;
  let done: Promise<unknown> | undefined;
  const first = async (): Promise<void> => {
    done ??= meanwhile();
    await done;
  };
  /** The statement, its every method waiting for `meanwhile` first. */
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
          await first();
          const result: unknown = await Reflect.apply(value, target, values);
          return result;
        };
      },
    });
  vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    if (!/^select .* from "idempotent_calls"/u.test(query)) {
      return statement;
    }
    reads += 1;
    return reads === nth ? delayed(statement) : statement;
  });
};

/** Sets the connection's stored calls' columns, as SQL `assignments` say. */
const storedCalls = async (
  { id }: Connection,
  assignments: string
): Promise<void> => {
  await env.DB.prepare(
    `UPDATE idempotent_calls SET ${assignments} WHERE connection_id = ?`
  )
    .bind(id)
    .run();
};

describe("a Microsoft 365 write of unknown outcome", () => {
  it("is neither looked up nor sent while its call may still be out, and says when to try again", async () => {
    const connection = await connected();
    // Graph makes the draft; its answer never arrives.
    graph.loseWriteAnswer();
    const outcomes = [
      await retryable(draft(connection, "run-1:draft")),
      await retryable(draft(connection, "run-1:draft")),
    ];
    expect({
      first: outcomes[0]?.code,
      again: outcomes[1]?.code,
      waitsSeconds:
        (outcomes[1]?.retryAfterSeconds ?? 0) > 0 &&
        (outcomes[1]?.retryAfterSeconds ?? 0) <= claimTimeoutMs / 1000,
      requests: requests().length,
    }).toStrictEqual({
      first: "connect.outcome_unknown",
      again: "connect.outcome_unknown",
      waitsSeconds: true,
      requests: 1,
    });
  });

  it("is found by its effect key once its call can no longer be out, and never made twice", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-1:draft"));
    await claimedAgo(connection);
    const found = await outputOf(draft(connection, "run-1:draft"));
    // From now on, a repeat gets the answer that was found.
    const repeat = await outputOf(draft(connection, "run-1:draft"));
    // Found under the key the write carried, by a lookup held to the
    // call's own mailbox: one write in all.
    const key = tagOf(writes()[0]?.body) ?? "";
    const audited = await audit.events();
    const details = audited
      .filter(({ action }) => action === "connection.call")
      .map(({ detail }) => detail);
    expect({
      found,
      repeat,
      keyed: effectKeyPattern.test(key),
      writesDone: graph.writesDone(),
      writes: writes().length,
      lookups: lookups().map(({ method, path, query }) => ({
        method,
        path,
        filter: query.$filter,
      })),
      audited: details.slice(-2),
    }).toMatchObject({
      found: { mailbox: invoices },
      repeat: found,
      keyed: true,
      writesDone: 1,
      writes: 1,
      lookups: [
        {
          method: "GET",
          path: `/v1.0/users/${encodeURIComponent(invoices)}/messages`,
          filter: `singleValueExtendedProperties/Any(ep: ep/id eq '${effectPropertyId}' and ep/value eq '${key}')`,
        },
      ],
      audited: [
        { outcome: "reconciled", recovery: "find" },
        { outcome: "replayed", replayed: true },
      ],
    });
  });

  it("is made once more, under the same key, when its lookup says it isn't there", async () => {
    const connection = await connected();
    // Graph fails the write before making anything.
    graph.failWrite(503);
    const lost = await outcome(draft(connection, "run-2:draft"));
    await claimedAgo(connection);
    const made = await outputOf(draft(connection, "run-2:draft"));
    // Both writes carried the same effect key: the call's.
    const [first = "", second] = writes().map(({ body }) => tagOf(body));
    expect({
      lost,
      made,
      writes: writes().length,
      lookups: lookups().length,
      keyed: effectKeyPattern.test(first),
      sameKey: second === first,
    }).toMatchObject({
      lost: "connect.outcome_unknown",
      made: { mailbox: invoices },
      writes: 2,
      lookups: 1,
      keyed: true,
      sameKey: true,
    });
  });

  it("stays unknown when its lookup is throttled or unavailable: a lookup that did nothing finds nothing", async () => {
    const connection = await connected();
    const outcomes: string[] = [];
    for (const [key, failLookup] of [
      [
        "run-3:throttled",
        () => {
          graph.throttle();
        },
      ],
      [
        "run-3:unavailable",
        () => {
          graph.failNext(503);
        },
      ],
    ] as const) {
      graph.failWrite(500);
      // oxlint-disable-next-line no-await-in-loop -- Graph fails one request at a time
      await outcome(draft(connection, key));
      // oxlint-disable-next-line no-await-in-loop -- Graph fails one request at a time
      await claimedAgo(connection);
      failLookup();
      // oxlint-disable-next-line no-await-in-loop -- Graph fails one request at a time
      outcomes.push(await outcome(draft(connection, key)));
    }
    expect({
      outcomes,
      writes: writes().length,
      lookups: lookups().length,
      states: await statesOf(connection),
    }).toStrictEqual({
      outcomes: ["connect.outcome_unknown", "connect.outcome_unknown"],
      // The two failed writes, and no other.
      writes: 2,
      lookups: 2,
      states: ["unknown", "unknown"],
    });
  });

  it("is recovered by one of two recoveries racing each other", async () => {
    const connection = await connected();
    graph.failWrite(500);
    await outcome(draft(connection, "run-4:draft"));
    await claimedAgo(connection);
    const outcomes = await Promise.all([
      outcome(draft(connection, "run-4:draft")),
      outcome(draft(connection, "run-4:draft")),
    ]);
    // One goes out; the other finds it under way, or its answer.
    expect({
      ok: outcomes.includes("ok"),
      others: outcomes.every(
        (ended) => ended === "ok" || ended === "connect.call_in_progress"
      ),
      writes: writes().length,
      lookups: lookups().length,
    }).toStrictEqual({ ok: true, others: true, writes: 2, lookups: 1 });
  });

  it("left running by a call that died is recovered by one of two recoveries racing each other", async () => {
    const connection = await connected();
    graph.failWrite(500);
    await outcome(draft(connection, "run-5:draft"));
    // As a call that died mid-way leaves it: still claimed, long ago.
    await storedCalls(connection, "state = 'running'");
    await claimedAgo(connection);
    const outcomes = await Promise.all([
      outcome(draft(connection, "run-5:draft")),
      outcome(draft(connection, "run-5:draft")),
    ]);
    expect({
      ok: outcomes.includes("ok"),
      writes: writes().length,
      lookups: lookups().length,
    }).toStrictEqual({ ok: true, writes: 2, lookups: 1 });
  });

  it("is never recovered with other input under its key", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-6:draft"));
    await claimedAgo(connection);
    await expect(
      outcome(
        call(
          connection,
          "mail.createDraft",
          { ...email, to: ["ceo@example.com"] },
          { resource: invoices, idempotencyKey: "run-6:draft" }
        )
      )
    ).resolves.toBe("connect.idempotency_conflict");
    expect(requests()).toHaveLength(1);
  });

  it("is never recovered for a connection that may no longer be used, and stays unknown", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-7:draft"));
    await claimedAgo(connection);
    await env.DB.prepare(
      "UPDATE connections SET status = 'disconnected' WHERE id = ?"
    )
      .bind(connection.id)
      .run();
    const ended = await outcome(draft(connection, "run-7:draft"));
    expect({
      ok: ended === "ok",
      requests: requests().length,
      states: await statesOf(connection),
    }).toStrictEqual({ ok: false, requests: 1, states: ["unknown"] });
  });

  it("is never recovered for a call its person must confirm, nor held for them again", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-8:draft"));
    await claimedAgo(connection);
    // The same run's call, from a context that has since read restricted
    // data: its side effects wait for its person.
    const ended = await outcome(
      callAs(
        agentFor(connection.person.userId),
        {
          connectionId: connection.id,
          action: "mail.createDraft",
          input: email,
          resource: invoices,
          idempotencyKey: "run-8:draft",
        },
        { restricted: true }
      )
    );
    const { results } = await env.DB.prepare(
      "SELECT id FROM pending_actions WHERE connection_id = ?"
    )
      .bind(connection.id)
      .all();
    expect({
      ended,
      held: results.length,
      requests: requests().length,
    }).toStrictEqual({
      ended: "connect.outcome_unknown",
      held: 0,
      requests: 1,
    });
  });

  it("is left unknown past the recovery horizon", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-9:draft"));
    await claimedAgo(connection, 25 * 60 * 60 * 1000);
    await expect(
      retryable(draft(connection, "run-9:draft"))
    ).resolves.toStrictEqual({ code: "connect.outcome_unknown" });
    expect(requests()).toHaveLength(1);
  });

  it("is left unknown when another connector release claimed it", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-10:draft"));
    // Claimed by a release that tagged nothing, say: not finding its tag
    // proves nothing.
    await storedCalls(connection, "connector_version = 'microsoft-365@0.0.1'");
    await claimedAgo(connection);
    await expect(
      retryable(draft(connection, "run-10:draft"))
    ).resolves.toStrictEqual({ code: "connect.outcome_unknown" });
    expect({
      requests: requests().length,
      lookups: lookups().length,
    }).toStrictEqual({ requests: 1, lookups: 0 });
  });

  it("is left unknown when another build of the same connector version claimed it", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-15:draft"));
    const [claimedBy] = await columnOf(connection, "connector_version");
    // The same version, other code: a build nobody bumped the version for.
    await storedCalls(
      connection,
      "connector_version = substr(connector_version, 1, instr(connector_version, '+')) || '0000000000000000'"
    );
    await claimedAgo(connection);
    const ended = await retryable(draft(connection, "run-15:draft"));
    expect({
      claimedBy: /^microsoft-365@[^+]+\+[0-9a-f]{16}$/u.test(String(claimedBy)),
      ended,
      requests: requests().length,
      lookups: lookups().length,
    }).toStrictEqual({
      claimedBy: true,
      ended: { code: "connect.outcome_unknown" },
      requests: 1,
      lookups: 0,
    });
  });

  it("sends nothing when another call takes the key over while its lookup runs", async () => {
    const connection = await connected();
    graph.failWrite(500);
    await outcome(draft(connection, "run-16:draft"));
    await claimedAgo(connection);
    // Between the "absent" answer and the send, another recovery claims
    // the key.
    let taken: unknown;
    graph.whileLookingUp(async () => {
      await storedCalls(connection, "claimed_at = claimed_at + 60000");
      [taken] = await columnOf(connection, "claimed_at");
    });
    const ended = await outcome(draft(connection, "run-16:draft"));
    expect({
      ended,
      writes: writes().length,
      lookups: lookups().length,
      states: await statesOf(connection),
      claimedAt: await columnOf(connection, "claimed_at"),
    }).toStrictEqual({
      ended: "connect.outcome_unknown",
      // The first, failed write, and no other.
      writes: 1,
      lookups: 1,
      // As the other claim left it.
      states: ["running"],
      claimedAt: [taken],
    });
  });

  it("keeps the horizon of its first claim when a recovery's send is throttled", async () => {
    const connection = await connected();
    graph.failWrite(500);
    await outcome(draft(connection, "run-17:draft"));
    // Near the end of the horizon, a recovery finds nothing and sends;
    // Graph throttles the write, which did nothing.
    await claimedAgo(connection, 23 * 60 * 60 * 1000);
    graph.throttleWrite();
    const throttled = await outcome(draft(connection, "run-17:draft"));
    const stateThen = await statesOf(connection);
    // Past 24 hours from the first claim, it isn't recovered again.
    await claimedAgo(connection, 2 * 60 * 60 * 1000);
    const later = await retryable(draft(connection, "run-17:draft"));
    expect({
      throttled,
      stateThen,
      later,
      writes: writes().length,
      lookups: lookups().length,
    }).toStrictEqual({
      throttled: "connect.server_unavailable",
      stateThen: ["unknown"],
      later: { code: "connect.outcome_unknown" },
      // The first write, the throttled one, and no third.
      writes: 2,
      lookups: 1,
    });
  });

  it("gets the answer another recovery stored between its two reads of the key", async () => {
    const connection = await connected();
    graph.failWrite(500);
    await outcome(draft(connection, "run-18:draft"));
    await claimedAgo(connection);
    const stored = {
      mailbox: invoices,
      id: "draft-recovered",
      conversationId: null,
      webLink: null,
    };
    // The call reads the key as unknown; before it reads it again, another
    // recovery stores its answer.
    beforeRead(2, async () => {
      await storedCalls(
        connection,
        `state = 'done', output = '${JSON.stringify(stored)}', provenance = '[]'`
      );
    });
    const answered = await outputOf(draft(connection, "run-18:draft"));
    vi.restoreAllMocks();
    expect({
      answered,
      writes: writes().length,
      lookups: lookups().length,
    }).toStrictEqual({ answered: stored, writes: 1, lookups: 0 });
  });

  it("whose lookup fails stays unknown, and waits a window anew", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-11:draft"));
    await claimedAgo(connection);
    // Graph fails the lookup itself.
    graph.failNext(500);
    const failed = await outcome(draft(connection, "run-11:draft"));
    const again = await retryable(draft(connection, "run-11:draft"));
    expect({
      failed,
      waits: (again.retryAfterSeconds ?? 0) > 0,
      writes: writes().length,
      lookups: lookups().length,
    }).toStrictEqual({
      failed: "connect.outcome_unknown",
      waits: true,
      writes: 1,
      lookups: 1,
    });
  });

  it("claimed but never stamped with its claim time is still under way, not stale", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(draft(connection, "run-12:draft"));
    // Claimed just now, by a row from before claim times were kept.
    await storedCalls(connection, "state = 'running', claimed_at = 0");
    await expect(outcome(draft(connection, "run-12:draft"))).resolves.toBe(
      "connect.call_in_progress"
    );
    expect(lookups()).toHaveLength(0);
  });
});

describe("a Microsoft 365 email of unknown outcome", () => {
  it("stays unknown: not finding its sent copy doesn't prove it wasn't sent", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await outcome(send(connection, "run-13:send"));
    await claimedAgo(connection);
    await expect(
      retryable(send(connection, "run-13:send"))
    ).resolves.toStrictEqual({ code: "connect.outcome_unknown" });
    expect({
      requests: requests().length,
      tagged: effectKeyPattern.test(tagOf(writes()[0]?.body) ?? ""),
    }).toStrictEqual({ requests: 1, tagged: true });
  });
});

describe("a call that lost its claim to a recovery", () => {
  it("frees nothing of the newer claim when its provider turns it away late", async () => {
    const connection = await connected();
    // While the write is with Graph, another call takes the key over (as a
    // recovery would); then Graph throttles the write, which did nothing.
    graph.throttleWriteWhile(async () => {
      await storedCalls(connection, "claimed_at = claimed_at + 1000");
    });
    const ended = await outcome(draft(connection, "run-14:draft"));
    expect({ ended, states: await statesOf(connection) }).toStrictEqual({
      ended: "connect.server_unavailable",
      // The newer claim is still there: its call may yet be out.
      states: ["running"],
    });
  });
});
