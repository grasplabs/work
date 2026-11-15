import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { addMember, removeMember } from "../src/app-members.ts";
import { holdingsOf, recallsTheBrain } from "../src/app-provenance.ts";
import { appUsersReadBy, appWriteFor } from "../src/brain-app-writes.ts";
import { memoriesAs, recallAs } from "../src/brain-next.ts";
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
  onPage,
  published,
  rememberedSchema,
  requestOf,
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
          id: someText,
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
    ]);

    const tried = async (app: App) =>
      await onPage(app, asAda, "remember", fact(`Reachco ${unique()}`));
    expect({
      teamBrain: await tried(teamBrain),
      mailbox: await tried(mailbox),
      reaching: await tried(reaching),
      reached: await tried(reached),
    }).toStrictEqual({
      teamBrain: { failed: "permission.brain_write_reach" },
      mailbox: { failed: "permission.brain_write_reach" },
      reaching: { failed: "permission.brain_write_reach" },
      reached: { failed: "permission.brain_write_reach" },
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
