// The Brain's events (GRA-1763): what people's steps were, kept per team
// and deleted once past their time. From the threat model on the issue:
// an event names a team, never a person or a connection, and a call's
// none of what it read;
// only calls that went through, made for a person, are kept, once each
// however often the outbox drains; events go on the clock 90 days after
// they happened, one dated later than when it was kept included, and one
// already past them is never kept. That nothing reads one back is the
// leak harness's (brain-next-leaks.test.ts plants one).
import { eventsKeptMs } from "@grasp-os/brain-next/contract";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { recordEvents } from "../src/brain-next.ts";
import { chatOf, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { inStoreOf } from "./brain-next-out-reads.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

const idp = mockIdp();

const setUpTime = { timeout: 60_000 };

const dayMs = 24 * 60 * 60 * 1000;

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

/** `entries` in connect's audit outbox, as connect records its calls. */
const inConnectOutbox = async (entries: AuditEntry[]): Promise<void> => {
  const db = connectDb();
  const events = entries.map((entry) => createAuditEvent(entry, "connect"));
  await db.batch(
    events.map((event) =>
      db
        .prepare(
          "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, ?)"
        )
        .bind(event.id, JSON.stringify(event), Date.now())
    )
  );
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
    onBehalfOf: personId,
    subjectType: "agent",
    ...detail,
  },
});

/** The steps of the events the shared store keeps for `team`, oldest first. */
const stepsOf = async (team: string): Promise<unknown[]> => {
  const rows = await eventsOf(team);
  return rows.map(({ step }) => step);
};

describe("the Brain's events", setUpTime, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a call a chat's agent made for its person as a step of each of their teams, never the person or the connection, once however often connect's outbox drains", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const [sales, finance] = await Promise.all([
      newTeam(person.userId),
      newTeam(person.userId),
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
    const kept = await eventsOf(sales, finance);
    await drainAuditOutboxes(env);

    expect({
      kept: kept.map(({ team, step, item }) => ({ team, step, item })),
      again: await eventsOf(sales, finance),
      namesNoOne: [person.userId, mail.id].every(
        (name) => !JSON.stringify(kept).includes(name)
      ),
      searched: await mail.searched(),
    }).toStrictEqual({
      kept: [
        { team: `team:${finance}`, step: "mail.search", item: null },
        { team: `team:${sales}`, step: "mail.search", item: null },
      ].toSorted((a, b) => a.team.localeCompare(b.team)),
      again: kept,
      namesNoOne: true,
      searched: ["invoice"],
    });
  });

  it("keeps only calls that went through for someone in a team", async () => {
    const [{ userId: member }, { userId: teamless }, { userId: former }] =
      await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
    const admin = await signedInApi(idp, "admin");
    const team = await newTeam(member, former);
    await admin.api.members.remove(former);

    await inConnectOutbox([
      call(member, { action: "deals.read" }),
      call(member, {
        action: "app.call",
        subjectType: "app",
      }),
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

    expect(kept.map(({ step, item }) => ({ step, item }))).toStrictEqual([
      { step: "deals.read", item: null },
      { step: "app.call", item: null },
    ]);
  });

  it("deletes each event on the clock once it is 90 days old, dates one after now as kept, and never keeps one already past its time", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const team = await newTeam(userId);
    const keptAt = Date.now();
    const step = (name: string, at: number) => ({
      key: crypto.randomUUID(),
      personId: userId,
      step: name,
      item: null,
      at: new Date(at),
    });
    await recordEvents(env, [
      step("almost old", keptAt - eventsKeptMs + dayMs),
      step("new", keptAt),
      step("from the future", keptAt + 10 * dayMs),
      step("too old", keptAt - eventsKeptMs - 1),
    ]);
    const stepsAt = async (at: number): Promise<unknown[]> => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
      await runMinuteTasks({}, new Date(at));
      return await stepsOf(team);
    };

    expect({
      kept: await stepsOf(team),
      dayAfter: await stepsAt(keptAt + dayMs + 60_000),
      dueDay: await stepsAt(keptAt + eventsKeptMs - 60_000),
      pastIt: await stepsAt(keptAt + eventsKeptMs + 60_000),
    }).toStrictEqual({
      kept: ["almost old", "new", "from the future"],
      dayAfter: ["new", "from the future"],
      dueDay: ["new", "from the future"],
      pastIt: [],
    });
  });
});
