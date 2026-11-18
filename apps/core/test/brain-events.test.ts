// The Brain's events (GRA-1763): what people's steps were, kept per team
// and deleted once past their time. From the threat model on the issue
// and its review: an event names a team, never a person or a connection,
// and a call's none of what it read; it is kept only for a team of at
// least five current members, so it is never one or two people's trail;
// its key can't be joined back to the audit log, and its time is kept to
// the hour; only calls that went through, made for a person, are kept,
// once each however often the outbox drains; events go on the clock 90
// days after they happened, one dated later than when it was kept
// included, and one already past them is never kept. Each carries a tag of
// who took it, keyed by core, one per person and team, by which a
// person's erasure deletes exactly theirs. That nothing reads one back is
// the leak harness's (brain-next-leaks.test.ts plants one).
import { eventsKeptMs } from "@grasp-os/brain-next/contract";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { minTeamShown } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { recordEvents } from "../src/brain-next.ts";
import { chatOf, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { inStoreOf } from "./brain-next-out-reads.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

const idp = mockIdp();

const setUpTime = { timeout: 60_000 };

const hourMs = 60 * 60 * 1000;

const dayMs = 24 * hourMs;

/** Every event the shared store keeps for `teams`, as its rows hold it. */
const eventsOf = async (...teams: string[]) =>
  await inStoreOf("brain", (sql) =>
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM events WHERE team IN (SELECT value FROM json_each(?)) ORDER BY team, at, row`,
        JSON.stringify(teams.map((team) => `team:${team}`))
      )
      .toArray()
  );

/** The steps of the events the shared store keeps for `team`, oldest first. */
const stepsOf = async (team: string): Promise<unknown[]> => {
  const rows = await eventsOf(team);
  return rows.map(({ step }) => step);
};

/** A new member, by their user ID. */
const aMember = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** `count` new members, by their user IDs. */
const membersOf = async (count: number): Promise<string[]> =>
  await Promise.all(Array.from({ length: count }, aMember));

/** An event row's key, item and tag. */
const parts = (row: Record<string, SqlStorageValue> | undefined) => [
  row?.key,
  row?.item,
  row?.who,
];

/** A step `personId` took now, as a producer hands it to `recordEvents`. */
const stepBy = (personId: string, name: string) => ({
  key: crypto.randomUUID(),
  personId,
  step: name,
  system: "crm",
  writes: false,
  item: null,
  at: new Date(),
});

/**
 * `entries` in connect's audit outbox, as connect records its calls, each
 * at its own `at` when given: the events, as stored.
 */
const inConnectOutbox = async (
  entries: (AuditEntry & { at?: number })[]
): Promise<{ id: string }[]> => {
  const db = connectDb();
  const events = entries.map(({ at, ...entry }) => {
    const event = createAuditEvent(entry, "connect");
    return at === undefined
      ? event
      : { ...event, at: new Date(at).toISOString() };
  });
  await db.batch(
    events.map((event) =>
      db
        .prepare(
          "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, ?)"
        )
        .bind(event.id, JSON.stringify(event), Date.now())
    )
  );
  return events;
};

/** A call connect audited, made for `personId` by an agent unless `detail` says otherwise. */
const call = (
  personId: string,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: { type: "agent", agentId: "agent", onBehalfOf: personId },
  action: "connection.call",
  target: { type: "connection", id: "conn-1" },
  // What connect names a toolkit's call by: its toolkit and tool, no item.
  provenance: ["crm/deals.update"],
  detail: {
    outcome: "ok",
    action: "deals.update",
    provider: "crm",
    sideEffect: true,
    onBehalfOf: personId,
    subjectType: "agent",
    ...detail,
  },
});

describe("the Brain's events", setUpTime, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a call a chat's agent made for its person for each of their teams of five or more, never the person, the connection or the call's audit id, once however often connect's outbox drains", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const others = await membersOf(minTeamShown - 1);
    // Five with the person; four with them.
    const [five, four] = await Promise.all([
      newTeam(person.userId, ...others),
      newTeam(person.userId, ...others.slice(1)),
    ]);
    const mail = await mailConnection([], mailWithSearch);
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => (await env.connections.call("MAIL", "mail.search", { query: "invoice" })).output;`
      ),
      says("Found it.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.search"],
      binding: "MAIL",
    });

    await chat.ask("Find the invoice.");
    await drainAuditOutboxes(env);
    const kept = await eventsOf(five, four);
    await drainAuditOutboxes(env);
    const logged = await allEvents();
    const callIds = logged.flatMap(({ id, action, target }) =>
      action === "connection.call" && target?.id === mail.id ? [id] : []
    );
    const stored = JSON.stringify(kept);

    expect({
      kept: kept.map(({ team, step, item }) => ({ team, step, item })),
      again: await eventsOf(five, four),
      calls: callIds.length,
      namesNoOne: [person.userId, mail.id, ...callIds].every(
        (name) => !stored.includes(name)
      ),
    }).toStrictEqual({
      kept: [{ team: `team:${five}`, step: "mail.search", item: null }],
      again: kept,
      calls: 1,
      namesNoOne: true,
    });
  });

  it("keeps only calls that went through for a current member, each to the hour", async () => {
    const [member, teamless, former] = await Promise.all([
      aMember(),
      aMember(),
      aMember(),
    ]);
    const others = await membersOf(minTeamShown - 1);
    const admin = await signedInApi(idp, "admin");
    // Five current members once the former one is removed.
    const team = await newTeam(
      member,
      former,
      ...others.slice(0, minTeamShown - 1)
    );
    await admin.api.members.remove(former);
    // Two calls in one hour, an hour ago, past whatever the clock reads.
    const hour = Math.floor(Date.now() / hourMs) * hourMs - hourMs;

    await inConnectOutbox([
      {
        ...call(member, { action: "deals.read", sideEffect: false }),
        at: hour + 5 * 60_000,
      },
      {
        ...call(member, { action: "app.call", subjectType: "app" }),
        at: hour + 50 * 60_000,
      },
      call(member, { action: "failed.call", outcome: "failed" }),
      call(member, { action: "held.call", outcome: "held" }),
      call(member, { action: "repeated.call", outcome: "replayed" }),
      call(member, { action: "replayed.call", replayed: true }),
      call(member, { action: "workflow.call", subjectType: "workflow" }),
      {
        ...call(member, { action: "system.call" }),
        detail: { outcome: "ok", action: "system.call" },
      },
      call(teamless, { action: "teamless.call" }),
      call(former, { action: "former.call" }),
    ]);
    await drainAuditOutboxes(env);
    const kept = await eventsOf(team);

    expect(
      kept.map(({ step, system, writes, item, at }) => ({
        step,
        system,
        writes,
        item,
        at,
      }))
    ).toStrictEqual([
      // In the system its connector is, and whether it changed something.
      { step: "deals.read", system: "crm", writes: 0, item: null, at: hour },
      { step: "app.call", system: "crm", writes: 1, item: null, at: hour },
    ]);
  });

  it("deletes each event on the clock once it is 90 days old, dates one after now as kept, and never keeps one already past its time", async () => {
    const userId = await aMember();
    const others = await membersOf(minTeamShown - 1);
    const team = await newTeam(userId, ...others);
    const keptAt = Date.now();
    // What each kept now is dated: its hour.
    const keptHour = Math.floor(keptAt / hourMs) * hourMs;
    const stepAt = (name: string, at: number) => ({
      key: crypto.randomUUID(),
      personId: userId,
      step: name,
      system: "crm",
      writes: false,
      item: null,
      at: new Date(at),
    });
    await recordEvents(env, [
      stepAt("almost.old", keptAt - eventsKeptMs + dayMs),
      stepAt("new", keptAt),
      stepAt("from.the.future", keptAt + 10 * dayMs),
      stepAt("too.old", keptAt - eventsKeptMs - hourMs),
    ]);
    const stepsAt = async (at: number): Promise<unknown[]> => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
      await runMinuteTasks({}, new Date(at));
      return await stepsOf(team);
    };

    expect({
      kept: await stepsOf(team),
      dayAfter: await stepsAt(keptHour + dayMs + 60_000),
      dueDay: await stepsAt(keptHour + eventsKeptMs - 60_000),
      pastIt: await stepsAt(keptHour + eventsKeptMs + 60_000),
    }).toStrictEqual({
      kept: ["almost.old", "new", "from.the.future"],
      dayAfter: ["new", "from.the.future"],
      dueDay: ["new", "from.the.future"],
      pastIt: [],
    });
  });

  it("tags each event with who took it: one tag for a person in a team, another for each other person and each other team", async () => {
    const [anna, ben] = await Promise.all([aMember(), aMember()]);
    const [three, four] = await Promise.all([
      membersOf(minTeamShown - 2),
      membersOf(minTeamShown - 1),
    ]);
    const [sales, finance] = await Promise.all([
      newTeam(anna, ben, ...three),
      newTeam(anna, ...four),
    ]);
    await recordEvents(env, [
      stepBy(anna, "deals.update"),
      stepBy(anna, "deals.read"),
      stepBy(ben, "deals.update"),
    ]);
    const tags = async (team: string) => {
      const rows = await eventsOf(team);
      return rows.map(({ step: name, who }) => ({ name, who }));
    };
    const inSales = await tags(sales);
    const inFinance = await tags(finance);
    const annaInSales = inSales.filter(({ who }) => who === inSales[0]?.who);

    expect({
      sales: inSales.length,
      annaOne: new Set(inSales.slice(0, 2).map(({ who }) => who)).size,
      benOther: inSales[2]?.who !== inSales[0]?.who,
      annaTwice: annaInSales.length,
      finance: inFinance.length,
      otherTeamOther: inFinance[0]?.who !== inSales[0]?.who,
    }).toStrictEqual({
      sales: 3,
      annaOne: 1,
      benOther: true,
      annaTwice: 2,
      finance: 2,
      otherTeamOther: true,
    });
  });

  it("keeps a removed member's events, and erases exactly an erased one's, in every team, leaving the others'", async () => {
    const admin = await signedInApi(idp, "admin");
    const anna = await signedInApi(idp, "user");
    const ben = await aMember();
    const [three, four] = await Promise.all([
      membersOf(minTeamShown - 2),
      membersOf(minTeamShown - 1),
    ]);
    const [sales, finance] = await Promise.all([
      newTeam(anna.userId, ben, ...three),
      newTeam(anna.userId, ...four),
    ]);
    await recordEvents(env, [
      stepBy(anna.userId, "deals.update"),
      stepBy(ben, "deals.update"),
      stepBy(three[0] ?? "", "deals.read"),
    ]);
    await admin.api.members.remove(anna.userId);
    const removed = {
      sales: await stepsOf(sales),
      finance: await stepsOf(finance),
    };
    await admin.api.members.erase(anna.userId, String(anna.person.name));

    expect({
      removed,
      erased: { sales: await stepsOf(sales), finance: await stepsOf(finance) },
    }).toStrictEqual({
      removed: {
        sales: ["deals.update", "deals.update", "deals.read"],
        finance: ["deals.update"],
      },
      erased: { sales: ["deals.update", "deals.read"], finance: [] },
    });
  });

  it("keys an event's key, item and tag by core's own secret: none is the plain SHA-256 of what it is made from, and another secret makes each anew", async () => {
    const anna = await aMember();
    const team = await newTeam(anna, ...(await membersOf(minTeamShown - 1)));
    const group = `team:${team}`;
    const observed = {
      key: crypto.randomUUID(),
      personId: anna,
      step: "deals.read",
      system: "crm",
      writes: false,
      item: "deal-42",
      at: new Date(),
    };
    await recordEvents(env, [observed]);
    await recordEvents(
      { ...env, BETTER_AUTH_SECRET: `another-${crypto.randomUUID()}` },
      [observed]
    );
    const [first, second] = await eventsOf(team);
    const plain = new Set(
      await Promise.all(
        [
          observed.key,
          JSON.stringify([observed.key, group]),
          observed.item,
          anna,
          JSON.stringify([anna, group]),
        ].map(async (text) => await sha256Hex(text))
      )
    );

    expect({
      rows: [first, second].filter(Boolean).length,
      plain: [...parts(first), ...parts(second)].some(
        (part) => typeof part === "string" && plain.has(part)
      ),
      anew: parts(first).map((part, index) => part !== parts(second)[index]),
    }).toStrictEqual({
      rows: 2,
      plain: false,
      anew: [true, true, true],
    });
  });
});
