import { sha256Hex } from "@grasp-os/shared/encoding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  exportSettled,
  tick,
} from "../../../packages/brain-next/test/export-reads.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { addMember, removeMember } from "../src/app-members.ts";
import { holdingsOf, recallsTheBrain } from "../src/app-provenance.ts";
import { removeApp } from "../src/app-removal.ts";
import { resetAppData } from "../src/app-schema.ts";
import { setArchived } from "../src/app-status.ts";
import { uuidFromHash } from "../src/audit-outbox.ts";
import { appUsersReadBy, appWriteFor } from "../src/brain-app-writes.ts";
import {
  codeCardAs,
  codeEntitiesAs,
  memoriesAs,
  recallAs,
} from "../src/brain-next.ts";
import { deleteStore, liveStoreOf } from "../src/data-stores.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { StoreHost } from "../src/store-host.ts";
import { allEvents } from "./audit-events.ts";
import {
  answerOf,
  appOf,
  byAgent,
  eventsOf,
  fact,
  grant,
  holdingFirst,
  idsOf,
  losingFirstReply,
  onPage,
  published,
  rememberedSchema,
  requestOf,
  storeOf,
  signedIn,
  someText,
  statementsOf,
  table,
  teamOf,
} from "./brain-writing-app.ts";
import type { App, Member } from "./brain-writing-app.ts";
import { failure as failureOf, person } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// An App's code remembering and forgetting in the Brain (GRA-1883; the
// threat model is on the issue): `ctx.brain.remember` and `.forget`, in
// the App's own word, read only through its own code by whoever uses it
// when it reads. How it can fail, and what each test holds it to:
// 1. Someone who may not use the App reads what it remembered: another
//    App's code, a team-mate it isn't shared with, chat recall and the
//    Memories page find nothing; an agent's or Code Mode's call of the
//    App's own code reads none of it.
// 2. A write says what fewer people may read than use the App: a table
//    of owners' or a team's rows, or one only builders read, for someone
//    who builds it, refuses, checked on the version the call runs on, a
//    publish during the call included; so do a team's part of the Brain,
//    a personal connection and another App it can reach.
// 3. A write from where its arguments may hold someone's chat: an
//    agent's and Code Mode's calls are refused, and write nothing.
// 4. A call made again writes again, or keeps an audit event that differs:
//    one memory and one `done`, the same event, by ids alone.
// The leak harness (brain-next-leaks.test.ts) probes the same calls with
// marked memories, every way they answer.

/** Signing people in, sealing and granting can be slow on CI. */
const setUpTime = { timeout: 180_000 };

/** The shared store's object, as core reaches it. */
const shared = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

describe("an App's code remembers and forgets for its users", setUpTime, () => {
  it("remembers for the App's users, read back through its own code; nothing else finds it; forgets only its own; and a call made again is one memory and one event", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const [bob, cara, dan] = await Promise.all([
      person("user"),
      person("user"),
      person("user"),
    ]);
    // Shared with Bob and Cara's team; Dan is in a team with Bob alone.
    const team = await teamOf(bob, cara);
    await teamOf(bob, dan);
    const app = await appOf(ada, admin);
    const other = await appOf(ada, admin);
    await addMember(env, ada, app.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const [asBob, asCara, asDan] = await Promise.all(
      [bob, cara, dan].map(async (member) => await signedIn(member))
    );
    if (asBob === undefined || asCara === undefined || asDan === undefined) {
      throw new Error("No sessions");
    }
    const name = `Acme ${unique()}`;
    const key = `call-${unique()}`;
    // An event kept again with other content is logged as a conflict.
    const warn = vi.spyOn(console, "warn");

    const written = rememberedSchema.parse(
      await onPage(app, asBob, "remember", fact(name), { key })
    );
    // The same call made again: the same memory.
    const again = await onPage(app, asBob, "remember", fact(name), { key });
    const card = await onPage(app, asCara, "get", { entity: written.entity });
    const found = await onPage(app, asCara, "find", { name });
    const recalled = await recallAs(env, bob.userId, {
      question: name,
      budget: { tokens: 2000 },
      personal: true,
    });

    expect({
      again,
      read: statementsOf(card),
      found: idsOf(found),
      // Another App's code, an agent's and Code Mode's call of this one.
      otherApp: await onPage(other, ada, "get", { entity: written.entity }),
      agent: await byAgent(app, asCara, "get", { entity: written.entity }),
      codeMode: await byAgent(
        app,
        asCara,
        "find",
        { name },
        { codeMode: true }
      ),
      // A team-mate it isn't shared with can't call it at all.
      dan: await onPage(app, asDan, "get", { entity: written.entity }),
      // Their own Memories page and chat recall: nothing of the App's.
      pages: await Promise.all(
        [bob, dan].map(async ({ userId }) => {
          const page = await memoriesAs(env, userId, {
            entity: { store: "shared", id: written.entity },
          });
          return page.memories;
        })
      ),
      recalled: recalled.memories.some(({ statement }) =>
        statement.includes(name)
      ),
    }).toStrictEqual({
      again: written,
      read: [`${name} is active`],
      found: [written.entity],
      otherApp: null,
      agent: null,
      codeMode: { entities: [], next: null },
      dan: { failed: "app.not_found" },
      pages: [[], []],
      recalled: false,
    });

    // Another App forgets none of it; its own forgets it, again the same.
    const forgotByOther = await onPage(other, ada, "forget", {
      memory: written.memory,
    });
    const forgetKey = `call-${unique()}`;
    const forgot = await onPage(
      app,
      asCara,
      "forget",
      { memory: written.memory },
      { key: forgetKey }
    );
    // Made again: answers the time the store recorded, so the same event.
    const forgotAgain = await onPage(
      app,
      asCara,
      "forget",
      { memory: written.memory },
      { key: forgetKey }
    );
    expect({
      forgotByOther,
      forgot,
      forgotAgain,
      read: statementsOf(
        await onPage(app, asBob, "get", { entity: written.entity })
      ),
    }).toStrictEqual({
      forgotByOther: false,
      forgot: true,
      forgotAgain: true,
      read: [],
    });

    // One `done` for the memory, the same event whichever call kept it,
    // by ids alone: never what it says.
    const remembered = await eventsOf(
      "brain.memory.remembered",
      written.memory,
      1
    );
    const forgotten = await eventsOf(
      "brain.memory.forgotten",
      written.memory,
      3
    );
    // The change the store recorded as the one that retired it: what its
    // one `done` is named by.
    const retiredBy = await runInDurableObject(shared(), (_i, state) =>
      state.storage.sql
        .exec<{ change: string }>(
          "SELECT retired_change AS change FROM memories WHERE id = ?",
          written.memory
        )
        .one()
    );
    expect({
      remembered: remembered.map(({ actor, target, detail }) => ({
        actor,
        target,
        detail,
      })),
      forgotten: forgotten
        .filter(({ detail }) => detail?.result === "done")
        .map(({ id, at, detail }) => ({ id, at, detail })),
      said: JSON.stringify([...remembered, ...forgotten]).includes(name),
      conflicts: warn.mock.calls.filter((args) =>
        [...remembered, ...forgotten].some(
          ({ id }) =>
            JSON.stringify(args).includes("audit.conflicting_duplicate") &&
            JSON.stringify(args).includes(id)
        )
      ).length,
    }).toStrictEqual({
      remembered: [
        {
          actor: { type: "app", appId: app.app, part: "server" },
          target: { type: "app", id: app.app },
          detail: {
            onBehalfOf: bob.userId,
            outcome: "done",
            memory: written.memory,
            entity: written.entity,
          },
        },
      ],
      // Cara's call and the same call made again: one event.
      forgotten: [
        {
          id: uuidFromHash(
            await sha256Hex(
              JSON.stringify(["brain.memory.forgotten", retiredBy.change])
            )
          ),
          at: someText,
          detail: {
            onBehalfOf: cara.userId,
            memory: written.memory,
            outcome: "done",
            result: "done",
          },
        },
      ],
      said: false,
      conflicts: 0,
    });
  });

  it("is refused, writing nothing, when an agent or Code Mode calls the App", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    const name = `Agentco ${unique()}`;

    expect({
      agent: await byAgent(app, ada, "remember", fact(name)),
      codeMode: await byAgent(app, ada, "remember", fact(name), {
        codeMode: true,
      }),
      found: idsOf(await onPage(app, ada, "find", { name })),
      // It declares no recall, yet holds the Brain: it answers no visitor
      // (app-visitor-calls.test.ts holds a visitor to that).
      answersNoVisitor: await recallsTheBrain(env, app.app),
    }).toStrictEqual({
      agent: { failed: "permission.brain_write_caller" },
      codeMode: { failed: "permission.brain_write_caller" },
      found: [],
      answersNoVisitor: true,
    });
  });

  it("writes only while every table of the version that runs is read by everyone who uses the App: owners', a team's or a person's rows refuse; builders' alone refuse a builder alone; a table nobody reads doesn't", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("user");
    const app = await appOf(ada, admin, { tables: { diary: table("owner") } });
    await addMember(env, ada, app.app, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const tried = async (by: Member) =>
      await onPage(app, by, "remember", fact(`Tableco ${unique()}`));
    const owners = await tried(ada);
    await published(app, 2, {
      diary: table("appMembers", [{ kind: "team", field: "team" }]),
    });
    const teams = await tried(ada);
    await published(app, 3, {
      diary: table("appMembers", [{ kind: "person", field: "assignee" }]),
    });
    const persons = await tried(ada);
    await published(app, 4, { plans: table("appBuilders") });
    const builders = {
      ada: await tried(ada),
      bob: rememberedSchema.safeParse(await tried(bob)).success,
    };
    await published(app, 5, {
      hidden: table("none"),
      notes: table("appMembers"),
      tasks: table("appMembers", [{ kind: "role", role: "user" }]),
    });
    const everyones = rememberedSchema.safeParse(await tried(ada)).success;

    expect({ owners, teams, persons, builders, everyones }).toStrictEqual({
      owners: { failed: "permission.brain_write_table" },
      teams: { failed: "permission.brain_write_table" },
      persons: { failed: "permission.brain_write_table" },
      builders: {
        ada: { failed: "permission.brain_write_builders_table" },
        bob: true,
      },
      everyones: true,
    });
  });

  it("checks the tables of the version the call runs on: a publish during the call that opens its owners' table still refuses it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin, { tables: { diary: table("owner") } });
    // The call's first request held until version 2 is current.
    const reached = Promise.withResolvers<null>();
    const held = Promise.withResolvers<null>();
    const holding = holdingFirst(env.BRAIN_STORE, "findEntities", async () => {
      reached.resolve(null);
      await held.promise;
    });
    const name = `Midco ${unique()}`;
    const during = onPage(app, ada, "both", fact(name), {
      on: { ...env, BRAIN_STORE: holding },
    });
    await reached.promise;
    await published(app, 2, { diary: table("appMembers") });
    held.resolve(null);

    expect({
      during: await during,
      // Version 2 itself writes: only the version that ran refused.
      after: rememberedSchema.safeParse(
        await onPage(app, ada, "remember", fact(`After ${unique()}`))
      ).success,
      found: idsOf(await onPage(app, ada, "find", { name })),
    }).toStrictEqual({
      during: { failed: "permission.brain_write_table" },
      after: true,
      found: [],
    });
  });

  it("writes only while everything the App can reach is everyone's: a team's part of the Brain, a personal connection and another App each refuse, for good", async () => {
    const admin = await person("admin");
    const ada = await signedIn(await person("builder"));
    const team = await teamOf(ada);
    const asAda = await signedIn(ada);
    const teamBrain = await appOf(asAda, admin, { teams: [team] });
    const mailbox = await appOf(ada, admin);
    const reaching = await appOf(ada, admin);
    const reached = await appOf(ada, admin);
    // Granted a Knowledge collection before the Brain replaced it, and,
    // besides, one also reaching an App that can't be placed.
    const knowledge = await appOf(ada, admin);
    const knowledgeAndMore = await appOf(ada, admin);
    // A personal connection, granted and then revoked: it still counts.
    const connection = `connection-mailbox-${unique()}`;
    const now = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?)"
      )
      .bind(connection, ada.userId, now, now)
      .run();
    const workflow = `workflow_${unique().replaceAll("-", "")}`;
    const unplaced = `workflow_${unique().replaceAll("-", "")}`;
    await env.DB.batch([
      grant(
        "app",
        mailbox.app,
        "connection",
        connection,
        ["mail.read"],
        "revoked"
      ),
      // Reaching starts a workflow that calls the other App's functions.
      grant("app", reaching.app, "workflow", workflow, ["start"]),
      grant("workflow", workflow, "app", reached.app, ["call"]),
      grant("app", knowledge.app, "collection", `collection-${unique()}`, [
        "read",
      ]),
      grant(
        "app",
        knowledgeAndMore.app,
        "collection",
        `collection-${unique()}`,
        ["read"]
      ),
      grant("app", knowledgeAndMore.app, "workflow", unplaced, ["start"]),
      grant("workflow", unplaced, "app", crypto.randomUUID(), ["call"]),
    ]);

    const tried = async (app: App) =>
      await onPage(app, asAda, "remember", fact(`Reachco ${unique()}`));
    expect({
      teamBrain: await tried(teamBrain),
      mailbox: await tried(mailbox),
      reaching: await tried(reaching),
      reached: await tried(reached),
      knowledge: await tried(knowledge),
      knowledgeAndMore: await tried(knowledgeAndMore),
    }).toStrictEqual({
      teamBrain: { failed: "permission.brain_write_reach" },
      mailbox: { failed: "permission.brain_write_reach" },
      reaching: { failed: "permission.brain_write_reach" },
      reached: { failed: "permission.brain_write_reach" },
      knowledge: { failed: "permission.brain_write_reach" },
      // The grant that lasts, whatever else can't be placed now.
      knowledgeAndMore: { failed: "permission.brain_write_reach" },
    });
  });

  it("records a forget as the one who forgot it, when they did: another's forget of it later forgets nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const [bob, cara] = await Promise.all([person("user"), person("user")]);
    const app = await appOf(ada, admin);
    for (const { userId } of [bob, cara]) {
      // oxlint-disable-next-line no-await-in-loop -- one share at a time
      await addMember(env, ada, app.app, {
        type: "person",
        id: userId,
        role: "user",
      });
    }
    const written = rememberedSchema.parse(
      await onPage(app, bob, "remember", fact(`Twice ${unique()}`))
    );
    const byBob = await onPage(app, bob, "forget", { memory: written.memory });
    const byCara = await onPage(app, cara, "forget", {
      memory: written.memory,
    });
    const outcomes = await eventsOf(
      "brain.memory.forgotten",
      written.memory,
      4
    );
    const done = outcomes.filter(({ detail }) => detail?.outcome === "done");
    const at = (who: string) =>
      done.find(({ detail }) => detail?.onBehalfOf === who)?.at ?? "";
    expect({
      byBob,
      byCara,
      results: done
        .map(({ detail }) => ({
          who: detail?.onBehalfOf === bob.userId ? "bob" : "cara",
          result: detail?.result,
        }))
        .toSorted((one, other) => one.who.localeCompare(other.who)),
      // Cara's is her own event, at her own time, never Bob's.
      caraAfterBob: at(cara.userId) > at(bob.userId),
    }).toStrictEqual({
      byBob: true,
      byCara: true,
      results: [
        { who: "bob", result: "done" },
        { who: "cara", result: "nothing" },
      ],
      caraAfterBob: true,
    });
  });

  it("writes from an App shaped like a seeded one: a board its users read and write, a workflow that calls only back into it; and reads it back", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("user");
    const app = await appOf(ada, admin, {
      tables: { board: table("appMembers") },
    });
    await addMember(env, ada, app.app, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    // Its workflow, as the walk sees its grants: the App starts it, and it
    // calls the App's functions and nothing else.
    const workflow = `workflow_${unique().replaceAll("-", "")}`;
    await env.DB.batch([
      grant("app", app.app, "workflow", workflow, ["start"]),
      grant("workflow", workflow, "app", app.app, ["call"]),
    ]);
    const name = `Seedco ${unique()}`;
    const written = rememberedSchema.parse(
      await onPage(app, bob, "remember", fact(name))
    );
    const { otherApps } = await holdingsOf(env, app.app);
    expect({
      otherApps,
      read: statementsOf(
        await onPage(app, ada, "get", { entity: written.entity })
      ),
    }).toStrictEqual({ otherApps: [], read: [`${name} is active`] });
  });

  it("stops reading what the App remembered for someone taken off it, its history included", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const cara = await person("user");
    const app = await appOf(ada, admin);
    await addMember(env, ada, app.app, {
      type: "person",
      id: cara.userId,
      role: "user",
    });
    const name = `Leaverco ${unique()}`;
    const written = rememberedSchema.parse(
      await onPage(app, ada, "remember", fact(name))
    );
    const learned = new Date().toISOString();
    await onPage(app, ada, "forget", { memory: written.memory });
    // History: as of before it was forgotten.
    const before = statementsOf(
      await onPage(app, cara, "get", { entity: written.entity, asOf: learned })
    );
    await removeMember(env, ada, app.app, { type: "person", id: cara.userId });
    expect({
      before,
      after: await onPage(app, cara, "get", {
        entity: written.entity,
        asOf: learned,
      }),
      readsTheApps: await appUsersReadBy(env, {
        app: app.app,
        origin: "page",
        personId: cara.userId,
      }),
    }).toStrictEqual({
      before: [`${name} is active`],
      after: { failed: "app.not_found" },
      readsTheApps: undefined,
    });
  });

  it("refuses someone who doesn't use the App, recording one refusal by ids; and a workflow's call, its outsider as one who can't reach the App", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const [bob, eve] = await Promise.all([person("user"), person("user")]);
    const app = await appOf(ada, admin);
    await addMember(env, ada, app.app, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const name = `Eveco ${unique()}`;
    const refusal = await failureOf(async () => {
      await appWriteFor(
        env,
        {
          app: app.app,
          origin: "page",
          authority: {
            subject: { type: "app", appId: app.app },
            onBehalfOf: eve.userId,
            mode: "interactive",
            appVersion: 1,
          },
          context: { type: "app", appId: app.app },
          permissionId: app.permissionId,
          actor: { type: "app", appId: app.app, part: "server" },
          key: `call-${unique()}`,
          builtInCall: false,
        },
        "remember",
        fact(name)
      );
    });
    // A call as a workflow's step makes one: no page, no agent.
    const asWorkflow = async (by: Member) => {
      const { result } = await callAppFunction(
        env,
        by,
        app.app,
        requestOf("remember", fact(`Wfco ${unique()}`)),
        Date.now() + 60_000
      );
      return answerOf(result);
    };
    const all = await allEvents();
    const eves = all.filter(
      ({ action, detail }) =>
        action === "brain.memory.remembered" &&
        detail?.onBehalfOf === eve.userId
    );
    expect({
      refusal,
      eves: eves.map(({ detail }) => detail),
      said: JSON.stringify(eves).includes(name),
      outsider: await asWorkflow(eve),
      user: await asWorkflow(bob),
    }).toStrictEqual({
      refusal: "permission.brain_write_not_user",
      eves: [
        {
          onBehalfOf: eve.userId,
          outcome: "refused",
          reason: "permission.brain_write_not_user",
        },
      ],
      said: false,
      outsider: { failed: "app.not_found" },
      user: { failed: "permission.brain_write_caller" },
    });
  });

  it("refuses a call held between its read and its write once its person is taken off the App, and writes nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("user");
    const app = await appOf(ada, admin);
    await addMember(env, ada, app.app, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const reached = Promise.withResolvers<null>();
    const held = Promise.withResolvers<null>();
    const holding = holdingFirst(env.BRAIN_STORE, "findEntities", async () => {
      reached.resolve(null);
      await held.promise;
    });
    const name = `Goneco ${unique()}`;
    const during = onPage(app, bob, "both", fact(name), {
      on: { ...env, BRAIN_STORE: holding },
    });
    await reached.promise;
    await removeMember(env, ada, app.app, { type: "person", id: bob.userId });
    held.resolve(null);
    expect({
      during: await during,
      found: idsOf(await onPage(app, ada, "find", { name })),
    }).toStrictEqual({ during: { failed: "app.not_found" }, found: [] });
  });

  it("refuses a builder taken down to a user during the call, with a table only builders read: what they read as a builder stays read", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const carl = await person("builder");
    const app = await appOf(ada, admin, {
      tables: { plans: table("appBuilders") },
    });
    await addMember(env, ada, app.app, {
      type: "person",
      id: carl.userId,
      role: "builder",
    });
    const reached = Promise.withResolvers<null>();
    const held = Promise.withResolvers<null>();
    const holding = holdingFirst(env.BRAIN_STORE, "findEntities", async () => {
      reached.resolve(null);
      await held.promise;
    });
    const name = `Demotedco ${unique()}`;
    const during = onPage(app, carl, "both", fact(name), {
      on: { ...env, BRAIN_STORE: holding },
    });
    await reached.promise;
    await removeMember(env, ada, app.app, { type: "person", id: carl.userId });
    await addMember(env, ada, app.app, {
      type: "person",
      id: carl.userId,
      role: "user",
    });
    held.resolve(null);
    expect({
      during: await during,
      // A new call as the user they are now writes.
      after: rememberedSchema.safeParse(
        await onPage(app, carl, "remember", fact(`Userco ${unique()}`))
      ).success,
      found: idsOf(await onPage(app, ada, "find", { name })),
    }).toStrictEqual({
      during: { failed: "permission.brain_write_builders_table" },
      after: true,
      found: [],
    });
  });
});

/** How many memories `writer` wrote that the shared store still holds, hidden ones too. */
const heldBy = async (writer: string): Promise<number> =>
  await runInDurableObject(
    inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM memories WHERE writer = ?",
          writer
        )
        .one().count
  );

/** Runs `work` on store `id`'s host, inside its object. */
const inHost = async <T>(
  id: string,
  work: (host: StoreHost) => Promise<T>
): Promise<T> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(id),
    async (_instance, state) => await work(new StoreHost(state, env))
  );

/**
 * `app`'s store, freed to be deleted as retention frees it: no sealed
 * release bound to it any more, and no receipt left that refers to it.
 */
const freed = async (app: App): Promise<void> => {
  await env.DB.prepare(
    "DELETE FROM sdk_resource_bindings WHERE kind = 'store' AND target_id = ?"
  )
    .bind(storeOf(app))
    .run();
  await inHost(storeOf(app), async (host) => {
    await host.sweepReceipts(new Date(Date.now() + 31 * 24 * 3_600_000));
  });
};

/**
 * Every erasure event of what `app`'s code remembered, once every outbox
 * is drained into the log (`allEvents`): exactly those, so a second one
 * kept later is never missed.
 */
const erasuresOf = async (app: string) => {
  const all = await allEvents();
  return all.filter(
    ({ action, target }) =>
      action === "brain.memory.erased" && target?.id === app
  );
};

/** The ID an erasure's event under `change` has: derived from the change. */
const erasureIdOf = async (change: string): Promise<string> =>
  uuidFromHash(
    await sha256Hex(JSON.stringify(["brain.memory.erased", change]))
  );

/** `on` with its database's first batch failing, as a call cut off before it lands. */
const firstBatchFailing = (on: Env): Env => {
  let failed = false;
  const database = new Proxy(on.DB, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property === "batch" && !failed) {
        return async () => {
          failed = true;
          await Promise.resolve();
          throw new Error("The batch was cut off (a test's)");
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...on, DB: database };
};

/**
 * `namespace` with object `name`'s `method` failing, on every call,
 * before it reaches the object: a call that never lands.
 */
const failing = <T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  method: string
): DurableObjectNamespace<T> => {
  const stubOf = (stub: object): object =>
    new Proxy(stub, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          if (property === method) {
            throw new Error("The call failed (a test's)");
          }
          return await Reflect.apply(value, target, args);
        };
      },
    });
  const namespaceOf = (
    of: DurableObjectNamespace<T>
  ): DurableObjectNamespace<T> =>
    new Proxy(of, {
      get: (target, property): unknown => {
        if (property === "jurisdiction") {
          return (jurisdiction: DurableObjectJurisdiction) =>
            namespaceOf(target.jurisdiction(jurisdiction));
        }
        if (property === "getByName") {
          return (named: string) => {
            const stub = target.getByName(named);
            return named === name ? stubOf(stub) : stub;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return namespaceOf(namespace);
};

describe("an App's memories go with its data", setUpTime, () => {
  it("erases what an App remembered when its store is deleted: its users read none of it, the store deletes it, an export taken before is stale, and one event records it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("user");
    const app = await appOf(ada, admin);
    await addMember(env, ada, app.app, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const name = `Deletedco ${unique()}`;
    const written = rememberedSchema.parse(
      await onPage(app, bob, "remember", fact(name))
    );
    const { id: before } = await shared().startExport("test");
    await expect(exportSettled(shared, before)).resolves.toBe("done");

    await freed(app);
    await deleteStore(env, ada, storeOf(app));
    await tick(shared());
    const status = await shared().exportStatus({ id: before });
    const events = await erasuresOf(app.app);
    const found = await codeEntitiesAs(
      env,
      bob.userId,
      "company",
      { name },
      app.app
    );
    expect({
      card: await codeCardAs(
        env,
        bob.userId,
        "company",
        { entity: written.entity },
        app.app
      ),
      found: found.entities,
      held: await heldBy(`app:${app.app}`),
      export: status?.state,
      events: events.map(({ id, actor, detail }) => ({ id, actor, detail })),
    }).toStrictEqual({
      card: null,
      found: [],
      held: 0,
      export: "erased",
      events: [
        {
          id: await erasureIdOf(`app-store-deleted:${storeOf(app)}`),
          actor: { type: "person", userId: ada.userId },
          detail: { cause: "store_deleted", memories: 1 },
        },
      ],
    });
  });

  it("erases what an App remembered when its data is reset; what it remembers afterwards is kept", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    const before = rememberedSchema.parse(
      await onPage(app, ada, "remember", fact(`Resetco ${unique()}`))
    );
    await resetAppData(env, admin, app.app, "Accounts");
    const afterName = `Afterco ${unique()}`;
    const after = rememberedSchema.parse(
      await onPage(app, ada, "remember", fact(afterName))
    );
    await tick(shared());
    const events = await erasuresOf(app.app);
    expect({
      before: await onPage(app, ada, "get", { entity: before.entity }),
      after: statementsOf(
        await onPage(app, ada, "get", { entity: after.entity })
      ),
      held: await heldBy(`app:${app.app}`),
      events: events.map(({ detail }) => detail),
    }).toStrictEqual({
      before: null,
      after: [`${afterName} is active`],
      held: 1,
      events: [{ cause: "data_reset", memories: 1 }],
    });
  });

  it("finishes the erasure of a deletion cut off before the store was marked deleted, on the store's alarm, with one event", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    const written = rememberedSchema.parse(
      await onPage(app, ada, "remember", fact(`Cutco ${unique()}`))
    );
    await freed(app);
    // Erased, then cut off before core's inventory marks it deleted.
    const cutOff = await failureOf(async () => {
      await deleteStore(firstBatchFailing(env), ada, storeOf(app));
    });
    const marked = await env.DB.prepare(
      "SELECT deleted_at FROM business_stores WHERE id = ?"
    )
      .bind(storeOf(app))
      .first<{ deleted_at: number | null }>();
    // The store's alarm, run here rather than waited for.
    await inHost(storeOf(app), async (host) => {
      await host.runAlarm({});
    });
    const done = await env.DB.prepare(
      "SELECT deleted_at FROM business_stores WHERE id = ?"
    )
      .bind(storeOf(app))
      .first<{ deleted_at: number | null }>();
    const events = await erasuresOf(app.app);
    expect({
      cutOff,
      markedThen: marked?.deleted_at ?? null,
      markedNow: done?.deleted_at !== null && done?.deleted_at !== undefined,
      card: await codeCardAs(
        env,
        ada.userId,
        "company",
        { entity: written.entity },
        app.app
      ),
      events: events.map(({ detail }) => detail),
    }).toStrictEqual({
      cutOff: "Error: The batch was cut off (a test's)",
      markedThen: null,
      markedNow: true,
      card: null,
      events: [{ cause: "store_deleted", memories: 1 }],
    });
  });

  it("erases once for a reset whose erasure's reply was lost, under the same change, and erases nothing more", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    for (const name of [`Lostco ${unique()}`, `Lostco ${unique()}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one memory at a time
      await onPage(app, ada, "remember", fact(name));
    }
    await resetAppData(
      { ...env, BRAIN_STORE: losingFirstReply(env.BRAIN_STORE, "eraseWriter") },
      admin,
      app.app,
      "Accounts"
    );
    const events = await erasuresOf(app.app);
    expect(events.map(({ detail }) => detail)).toStrictEqual([
      { cause: "data_reset", memories: 2 },
    ]);
  });

  it("never marks a store deleted while its App's memories can't be erased, and leaves a failed reset's memories erased", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const [deleted, reset] = await Promise.all([
      appOf(ada, admin),
      appOf(ada, admin),
    ]);
    const kept = await Promise.all(
      [deleted, reset].map(async (app) =>
        rememberedSchema.parse(
          await onPage(app, ada, "remember", fact(`Orderco ${unique()}`))
        )
      )
    );
    await freed(deleted);
    const erasing = await failureOf(async () => {
      await deleteStore(
        {
          ...env,
          BRAIN_STORE: failing(env.BRAIN_STORE, "brain", "eraseWriter"),
        },
        ada,
        storeOf(deleted)
      );
    });
    const marked = await env.DB.prepare(
      "SELECT deleted_at FROM business_stores WHERE id = ?"
    )
      .bind(storeOf(deleted))
      .first<{ deleted_at: number | null }>();
    const resetting = await failureOf(async () => {
      await resetAppData(
        {
          ...env,
          DATA_STORES: failing(env.DATA_STORES, storeOf(reset), "resetData"),
        },
        admin,
        reset.app,
        "Accounts"
      );
    });
    expect({
      erasing,
      marked: marked?.deleted_at ?? null,
      resetting,
      // Still the deleted App's, and the reset App's gone.
      deletedApps: await codeCardAs(
        env,
        ada.userId,
        "company",
        { entity: kept[0]?.entity ?? "" },
        deleted.app
      ).then((card) => card !== null),
      resetApps: await codeCardAs(
        env,
        ada.userId,
        "company",
        { entity: kept[1]?.entity ?? "" },
        reset.app
      ),
    }).toStrictEqual({
      erasing: "Error: The call failed (a test's)",
      marked: null,
      resetting: "Error: The call failed (a test's)",
      deletedApps: true,
      resetApps: null,
    });
  });

  it("erases what an App without a store remembered when its data is reset, and keeps what it remembered after, unreadable, once it is removed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // As production makes an App with no tables: it never gets a store.
    const app = await appOf(ada, admin, { store: false });
    const before = rememberedSchema.parse(
      await onPage(app, ada, "remember", fact(`Storelessco ${unique()}`))
    );
    await resetAppData(env, admin, app.app, "Accounts");
    const afterReset = await codeCardAs(
      env,
      ada.userId,
      "company",
      { entity: before.entity },
      app.app
    );
    await onPage(app, ada, "remember", fact(`Laterco ${unique()}`));
    await setArchived(env, ada, app.app, true);
    await removeApp(env, ada, app.app);
    await tick(shared());
    const events = await erasuresOf(app.app);
    expect({
      afterReset,
      // Kept, as its data would be, and read by no one.
      held: await heldBy(`app:${app.app}`),
      readBy: await appUsersReadBy(env, {
        app: app.app,
        origin: "page",
        personId: ada.userId,
      }),
      events: events.map(({ detail }) => detail),
    }).toStrictEqual({
      afterReset: null,
      held: 1,
      readBy: undefined,
      events: [{ cause: "data_reset", memories: 1 }],
    });
  });

  it("erases what an App remembered while it had no store when a store it gets later is reset, and when that store is deleted", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin, { store: false });
    const storeless = rememberedSchema.parse(
      await onPage(app, ada, "remember", fact(`Nostoreco ${unique()}`))
    );
    // A version with a table: its seal mints the App's store.
    await published(app, 2, { notes: table("appMembers") });
    await resetAppData(env, admin, app.app, "Accounts");
    const afterReset = await codeCardAs(
      env,
      ada.userId,
      "company",
      { entity: storeless.entity },
      app.app
    );
    const stored = rememberedSchema.parse(
      await onPage(app, ada, "remember", fact(`Storedco ${unique()}`))
    );
    const store = await liveStoreOf(env, app.app);
    if (store === null) {
      throw new Error("The App got no store");
    }
    await freed({ ...app, store });
    await deleteStore(env, ada, store);
    const events = await erasuresOf(app.app);
    expect({
      afterReset,
      afterDeletion: await codeCardAs(
        env,
        ada.userId,
        "company",
        { entity: stored.entity },
        app.app
      ),
      events: events.map(({ detail }) => detail),
    }).toStrictEqual({
      afterReset: null,
      afterDeletion: null,
      events: [
        { cause: "data_reset", memories: 1 },
        { cause: "store_deleted", memories: 1 },
      ],
    });
  });

  it("keeps a removed App's memories with its store, and erases them when an admin deletes that store", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await appOf(ada, admin);
    await onPage(app, ada, "remember", fact(`Removedco ${unique()}`));
    await setArchived(env, ada, app.app, true);
    await removeApp(env, ada, app.app);
    const kept = await heldBy(`app:${app.app}`);
    // A removed App's store is its admins' alone.
    await freed(app);
    await deleteStore(env, admin, storeOf(app));
    await tick(shared());
    const events = await erasuresOf(app.app);
    expect({
      kept,
      held: await heldBy(`app:${app.app}`),
      events: events.map(({ id, detail }) => ({
        id,
        detail,
      })),
    }).toStrictEqual({
      kept: 1,
      held: 0,
      events: [
        {
          id: await erasureIdOf(`app-store-deleted:${storeOf(app)}`),
          detail: { cause: "store_deleted", memories: 1 },
        },
      ],
    });
  });
});
