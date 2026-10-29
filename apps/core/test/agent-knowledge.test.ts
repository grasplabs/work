import { agentErrors } from "@grasp-os/shared/agent";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { citedSnippetMax } from "@grasp-os/shared/chat";
import type { ChatMessage } from "@grasp-os/shared/chat";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { CollectionInput, PurgeInput } from "@grasp-os/shared/knowledge";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  requestChars,
  withheldResponse,
  withheldResult,
} from "../src/agent.ts";
import { refreshDailySignals } from "../src/daily-signals.ts";
import { workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  personalChatsOf,
  codeResults,
  codeStatuses,
  codeStep,
  readApiStep,
  gatewayConfig,
  model,
  pausedReply,
  pointAtGateway,
  says,
  setObjectEnv,
} from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam, readCollection } from "./knowledge.ts";
import {
  callAuth,
  outcome,
  signedInApi,
  signedInWithRole,
  unique,
} from "./sign-in.ts";

// `env.knowledge` in a chat's code: the chat's agent reading Knowledge for
// its person. These tests start from the ways it can fail: the agent reads
// a collection it wasn't granted, or one its person can't read (R5); a
// read leaves no trace in the audit log; and what one turn read reaches a
// model in a later turn, or after a restart, that the client's rules
// forbid for it, because the chat forgot it had read it.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** An admin who creates collections and grants the agent its permissions. */
const newAdmin = async () => {
  const admin = await signedInApi(idp, "admin");
  return { ...admin, knowledge: admin.api.knowledge };
};

/** A member of the organization, whom no other test uses: the chat's person. */
const newPerson = async () => await signedInWithRole(idp, "user");

type Admin = Awaited<ReturnType<typeof newAdmin>>;

const pinnedPrefix = "brain-document:";

/**
 * A withheld source as its IDs name it: a pinned document version's
 * (`brainDocumentRead`) as `brain-document:<collection>/<document>`, so a
 * test needn't know the pin; any other as it is.
 */
const sourceNamed = (source: unknown): string => {
  const text = String(source);
  if (!text.startsWith(pinnedPrefix)) {
    return text;
  }
  const [collectionId, documentId] = z
    .tuple([z.string(), z.string(), z.int(), z.string()])
    .parse(JSON.parse(text.slice(pinnedPrefix.length)));
  return `${pinnedPrefix}${collectionId}/${documentId}`;
};

/** Grants `agent` reading `collectionId`, under `binding`. */
const grantRead = async (
  admin: Admin,
  agent: { type: "agent"; agentId: string },
  collectionId: string
) => {
  await requestGranted(
    idp,
    admin,
    readCollection(agent, collectionId, `C${unique()}`.toUpperCase())
  );
};

/** The audit events of the chat's agent, once `done` holds for them. */
const eventsOf = async (
  agentId: string,
  done: (events: AuditEvent[]) => boolean
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "agent" && actor.agentId === agentId
    );
  };
  await vi.waitFor(
    async () => {
      expect(done(await mine())).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** A collection of `admin`'s with a document past its review date. */
const overdueIn = async (
  admin: Admin,
  input: CollectionInput
): Promise<string> => {
  const { id } = await admin.knowledge.createCollection(input);
  await admin.knowledge.saveDocument({
    collectionId: id,
    path: "old.md",
    text: "---\nreview: 2020-01-01\n---\n# Old\n\nDue for a look.",
    ifVersion: 0,
  });
  return id;
};

const modelCalls = (events: AuditEvent[]) =>
  events.filter(({ action }) => action === "model.call");

/** Code that returns the text of the document `documentId`. */
const readCode = (documentId: string) =>
  `export default async (self, env) => (await env.knowledge.read(${JSON.stringify(documentId)})).text;`;

const leave = "# Parental leave\n\nParental leave lasts sixteen weeks.";

describe("a chat's Knowledge", setUpTime, () => {
  it("answers a policy question from the document it read, and every read is recorded", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { id: documentId } = await admin.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: leave,
      ifVersion: 0,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      readApiStep("knowledge"),
      codeStep(
        "export default async (self, env) => { const { hits } = await env.knowledge.search('parental leave'); const doc = await env.knowledge.read(hits[0].documentId, { section: hits[0].section }); return { title: doc.title, path: doc.path, text: doc.text }; };"
      ),
      says("Sixteen weeks (Handbook, leave.md).")
    );
    await grantRead(admin, agent, collectionId);

    const reply = await ask("How long is parental leave?");

    // Labelled with the collection it read.
    expect(reply).toStrictEqual({
      outcome: "answered",
      answer: "Sixteen weeks (Handbook, leave.md).",
      provenance: { sources: [collectionId], restricted: false },
      // It links to no note: it cites none.
      cited: [],
      check: null,
      channelText: null,
    });
    // Every request lists the APIs, a line each; the model read the full
    // declaration it needed before it wrote the code.
    const [listed, declared] = gateway.requests.map((request) =>
      JSON.stringify(request.body)
    );
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: false,
        text: `Returned:\n${JSON.stringify({
          title: "Parental leave",
          path: "leave.md",
          text: leave,
        })}`,
      },
    ]);
    expect({
      listed: listed?.includes("- env.knowledge: "),
      declaredUpFront: listed?.includes("interface KnowledgeHit {"),
      readOnDemand: [
        declared?.includes("interface KnowledgeHit {"),
        declared?.includes("knowledge: {"),
      ],
    }).toStrictEqual({
      listed: true,
      declaredUpFront: false,
      readOnDemand: [true, true],
    });
    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 3
    );
    // Both reads, as the chat's agent acting for its person, with where
    // they read from and never what; then the request after the read,
    // which names the collection it came from.
    expect({
      reads: events
        .filter(({ action }) => action.startsWith("knowledge."))
        .map(({ action, actor, target, provenance }) => ({
          action,
          actor,
          target,
          provenance,
        })),
      requests: modelCalls(events).map(({ provenance }) => provenance),
      content: JSON.stringify(events).includes("sixteen"),
    }).toStrictEqual({
      reads: [
        {
          action: "knowledge.search",
          actor: { ...agent, onBehalfOf: person.userId },
          target: undefined,
          provenance: [collectionId, documentId],
        },
        {
          action: "knowledge.read",
          actor: { ...agent, onBehalfOf: person.userId },
          target: { type: "document", id: documentId },
          provenance: [collectionId],
        },
      ],
      requests: [[], [], [collectionId]],
      content: false,
    });
  });

  it("can't read a collection the agent wasn't granted, or one its person can't read", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const teamId = await newTeam(admin, []);
    const [granted, notGranted, team] = await Promise.all([
      collectionWithNote(admin, { name: "Granted", access: "everyone" }),
      collectionWithNote(admin, { name: "Not granted", access: "everyone" }),
      // A team the chat's person isn't in.
      collectionWithNote(admin, {
        name: "Team",
        access: "teams",
        teams: [teamId],
      }),
    ]);
    const ids = [granted.noteId, notGranted.noteId, team.noteId];
    const { stub, chat, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const tried = async (read) => { try { await read(); return "ok"; } catch (error) { return error.message; } };
          const catalog = await env.knowledge.catalog();
          const found = await env.knowledge.search("note");
          const reads = [];
          for (const id of ${JSON.stringify(ids)}) {
            reads.push([await tried(() => env.knowledge.read(id)), await tried(() => env.knowledge.follow(id))]);
          }
          return {
            catalog: catalog.collections.map(({ id }) => id),
            found: [...new Set(found.hits.map(({ collectionId }) => collectionId))],
            reads,
          };
        };`
      ),
      says("Done.")
    );
    await grantRead(admin, agent, granted.collectionId);
    await grantRead(admin, agent, team.collectionId);

    await ask("What can you read?");

    const [result] = await codeResults(stub, chat.id);
    const notFound = knowledgeErrors.create("knowledge.not_found").message;
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({
        catalog: [granted.collectionId],
        found: [granted.collectionId],
        reads: [
          ["ok", "ok"],
          [notFound, notFound],
          [notFound, notFound],
        ],
      })}`
    );
    // The catalog, which Knowledge doesn't record, is recorded as a call.
    const events = await eventsOf(agent.agentId, (all) =>
      all.some(
        ({ action, detail }) => action === "agent.call" && detail.turn !== true
      )
    );
    expect(
      events
        // Not the catalog each turn reads for its skills.
        .filter(
          ({ action, detail }) =>
            action === "agent.call" && detail.turn !== true
        )
        .map(({ detail }) => detail)
    ).toStrictEqual([
      {
        method: "knowledge.catalog",
        collections: 1,
        skills: 0,
        chat: chat.id,
        outcome: "ok",
        reason: null,
      },
    ]);
  });

  it("judges every later request by what the chat read, in later turns and after a restart", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const { collectionId, noteId } = await collectionWithNote(admin, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { stub, chat, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => (await env.knowledge.read(${JSON.stringify(noteId)})).title;`
      ),
      says("Note."),
      says("Still here.")
    );
    await grantRead(admin, agent, collectionId);

    await ask("Read the note.");
    await ask("And now?");
    await evictDurableObject(stub);
    await pointAtGateway(stub, fakeGateway(says("After a restart.")));
    await stub.ask(chat.id, { text: "And now?", model });

    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 4
    );
    expect(
      modelCalls(events).map(({ provenance }) => provenance)
    ).toStrictEqual([[], [collectionId], [collectionId], [collectionId]]);
  });

  it("keeps a chat that read a sensitive collection to the models its data rule allows, in every later turn", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const teamId = await newTeam(admin, [person]);
    const payroll = await collectionWithNote(admin, {
      name: `Payroll ${unique()}`,
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => (await env.knowledge.read(${JSON.stringify(payroll.noteId)})).title;`
      ),
      says("Never sent.")
    );
    const euModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    await pointAtGateway(stub, gateway, {
      config: {
        gateway: gatewayConfig.gateway,
        models: [model, euModel],
        sensitive: { models: [euModel] },
      },
    });
    await grantRead(admin, agent, payroll.collectionId);

    // The read is sensitive: the request after it is refused, before it
    // is sent, and so is the next turn, by what the chat read.
    const first = await ask("Read the payroll note.");
    await expect(outcome(ask("And now?"))).resolves.toBe(
      "model.sensitive_data"
    );

    expect(first.outcome).toBe("failed");
    expect(gateway.requests).toHaveLength(1);
    const events = await eventsOf(
      agent.agentId,
      (all) =>
        all.filter(({ action }) => action === "model.refused").length === 2
    );
    expect(
      events
        .filter(({ action }) => action === "model.refused")
        .map(({ detail, provenance }) => ({
          because: detail.because,
          provenance,
        }))
    ).toStrictEqual([
      { because: "collection", provenance: [payroll.collectionId] },
      { because: "collection", provenance: [payroll.collectionId] },
    ]);
    await expect(stub.isChatRestricted(chat.id)).resolves.toBeTruthy();
  });

  it("reads in every chat of the workspace under one grant, each chat keeping its own sources", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const { collectionId, noteId } = await collectionWithNote(admin, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const read = codeStep(
      `export default async (self, env) => (await env.knowledge.read(${JSON.stringify(noteId)})).title;`
    );
    const { stub, chat, ask, agent } = await chatOf(
      person.userId,
      read,
      says("Note."),
      says("Hi."),
      read,
      says("Note here too.")
    );
    const other = await stub.createChat("Other", person.userId, agent.agentId);
    // Granted once, to the workspace's agent.
    await grantRead(admin, agent, collectionId);

    const first = await ask("Read the note.");
    // Another chat of the workspace hasn't read anything yet: its first
    // request carries nothing the first chat read.
    const hello = await stub.ask(other.id, { text: "Hi.", model });
    const second = await stub.ask(other.id, { text: "Read it.", model });

    expect({
      first: first.outcome,
      hello: hello.outcome,
      second: second.outcome,
      results: [
        ...(await codeResults(stub, chat.id)),
        ...(await codeResults(stub, other.id)),
      ].map(({ text }) => text),
    }).toStrictEqual({
      first: "answered",
      hello: "answered",
      second: "answered",
      results: ["Returned:\nNote", "Returned:\nNote"],
    });
    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 5
    );
    // Every request names its chat, and carries that chat's sources only.
    expect(
      modelCalls(events).map(({ detail, provenance }) => ({
        chat: detail.chat,
        provenance,
      }))
    ).toStrictEqual([
      { chat: chat.id, provenance: [] },
      { chat: chat.id, provenance: [collectionId] },
      { chat: other.id, provenance: [] },
      { chat: other.id, provenance: [] },
      { chat: other.id, provenance: [collectionId] },
    ]);
  });

  it("makes no chat for an agent whose ID isn't a plain identifier", async () => {
    const person = await newPerson();
    const stub = workspace(env, workspaceIdSchema.parse(crypto.randomUUID()));
    // What no agent core names looks like: it would reach into another
    // agent's memory path.
    await expect(
      outcome(stub.createChat("Questions", person.userId, "../other"))
    ).resolves.toBe("permission.context_invalid");
  });

  it("surfaces its person's usage signals, only of collections it may read and none sensitive", async () => {
    const owner = await newAdmin();
    const someoneElse = await newAdmin();
    const teamId = await newTeam(owner, []);
    const granted = await overdueIn(owner, {
      name: "Granted",
      access: "everyone",
    });
    // The agent may not read it.
    await overdueIn(owner, {
      name: "Not granted",
      access: "everyone",
    });
    const sensitive = await overdueIn(owner, {
      name: "Sensitive",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const theirs = await overdueIn(someoneElse, {
      name: "Theirs",
      access: "everyone",
    });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await refreshDailySignals(env, tomorrow);
    const { stub, chat, ask, agent } = await chatOf(
      owner.userId,
      codeStep(
        "export default async (self, env) => { const { signals } = await env.knowledge.signals(); return signals.map(({ kind, collection }) => [kind, collection.id]); };"
      ),
      says("One document is past its review date.")
    );
    for (const collectionId of [granted, sensitive, theirs]) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await grantRead(owner, agent, collectionId);
    }

    const reply = await ask("Anything I should look at?");

    const [result] = await codeResults(stub, chat.id);
    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 2
    );
    expect({
      reply,
      result: result?.text,
      calls: events
        .filter(
          ({ action, detail }) =>
            action === "agent.call" && detail.method === "knowledge.signals"
        )
        .map(({ detail }) => ({
          method: detail.method,
          signals: detail.signals,
          outcome: detail.outcome,
        })),
    }).toStrictEqual({
      reply: {
        outcome: "answered",
        answer: "One document is past its review date.",
        // It read nothing it must name, and nothing restricted.
        provenance: { sources: [], restricted: false },
        cited: [],
        check: null,
        channelText: null,
      },
      result: `Returned:\n${JSON.stringify([["overdue_review", granted]])}`,
      calls: [{ method: "knowledge.signals", signals: 1, outcome: "ok" }],
    });
  });

  it("cites in an answer only the notes its chat's code was given before it, each once, never one read after it", async () => {
    const admin = await newAdmin();
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { id: read } = await admin.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: leave,
      ifVersion: 0,
    });
    // In a collection the agent may read, but nothing hands it over.
    const { id: unread } = await admin.knowledge.saveDocument({
      collectionId,
      path: "travel.md",
      text: "# Travel\n\nBook trains.",
      ifVersion: 0,
    });
    // In a collection the agent was never granted.
    const { id: hidden } = await admin.knowledge.createCollection({
      name: `Board ${unique()}`,
      access: "everyone",
    });
    const { id: secret } = await admin.knowledge.saveDocument({
      collectionId: hidden,
      path: "minutes.md",
      text: "# Minutes\n\nLeave stays as it is.",
      ifVersion: 0,
    });
    const answer = `Sixteen weeks [Parental leave](grasp:note/${read}), as [the policy](grasp:note/${read}) says; see [Travel](grasp:note/${unread}), [Minutes](grasp:note/${secret}) and [nothing](grasp:note/not-a-document).`;
    const { agent, newChat } = await personalChatsOf(
      person.userId,
      // Before its code read anything: the note is read only after.
      says(`Let me look [Parental leave](grasp:note/${read}).`),
      codeStep(
        "export default async (self, env) => { const { hits } = await env.knowledge.search('parental leave'); await env.knowledge.read(hits[0].documentId); return hits.length; };"
      ),
      says(answer),
      // The same words in another chat of the person's, whose code read nothing.
      says(answer)
    );
    await grantRead(admin, agent, collectionId);
    const reading = await newChat();
    await reading.ask("Parental leave?");
    await reading.ask("How long is parental leave?");
    const other = await newChat();
    await other.ask("And travel?");

    /** The chat's answers, as its page is sent them. */
    const answers = async (chatId: string) => {
      const sent: ChatMessage[] = [];
      const subscription = await person.api.chats.watch(
        chatId,
        null,
        (update) => {
          sent.push(...update.messages);
        }
      );
      await vi.waitFor(() => {
        expect(sent.some(({ role }) => role === "assistant")).toBeTruthy();
      });
      await subscription.release();
      const shown = sent.flatMap((message) =>
        message.role === "assistant" && message.text !== "" ? [message] : []
      );
      return await Promise.all(
        shown.map(async ({ id, text, citations }) => ({
          text,
          citations,
          cited: await person.api.chats.cited(chatId, id),
        }))
      );
    };

    expect({
      reading: await answers(reading.chat.id),
      other: await answers(other.chat.id),
    }).toStrictEqual({
      reading: [
        { text: "Let me look Parental leave.", citations: [], cited: [] },
        {
          text: `Sixteen weeks [Parental leave](grasp:note/${read}), as [the policy](grasp:note/${read}) says; see Travel, Minutes and nothing.`,
          citations: [{ kind: "document", documentId: read }],
          cited: [
            {
              documentId: read,
              collectionId,
              title: "Parental leave",
              path: "leave.md",
              snippet: "Parental leave lasts sixteen weeks.",
              spans: [
                { at: 14, text: "Parental leave", quote: null },
                {
                  at: `Sixteen weeks [Parental leave](grasp:note/${read}), as `
                    .length,
                  text: "the policy",
                  quote: null,
                },
              ],
            },
          ],
        },
      ],
      other: [
        {
          text: "Sixteen weeks Parental leave, as the policy says; see Travel, Minutes and nothing.",
          citations: [],
          cited: [],
        },
      ],
    });
  });

  it("gives an answer the documents it cites, with their title, path and snippet: never one only read, nor one its person can no longer read", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const teamId = await newTeam(admin, [person]);
    const { id: handbook } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { id: plans } = await admin.knowledge.createCollection({
      name: `Plans ${unique()}`,
      access: "teams",
      teams: [teamId],
    });
    // One long section: its snippet is read from the start of it.
    const rule = "Arrive on time. ";
    const [leaveDoc, travel, plan, rules] = await Promise.all(
      [
        { collectionId: handbook, path: "leave.md", text: leave },
        {
          collectionId: handbook,
          path: "travel.md",
          text: "# Travel\n\nBook trains.",
        },
        {
          collectionId: plans,
          path: "routes/plan.md",
          text: `---\ndescription: Where the route goes, and when.\n---\n# Route plan\n\nDeparts at nine\nfrom the depot.`,
        },
        {
          collectionId: handbook,
          path: "rules.md",
          text: `# House rules\n\n${rule.repeat(20_000)}`,
        },
      ].map(
        async (document) =>
          await admin.knowledge.saveDocument({ ...document, ifVersion: 0 })
      )
    );
    const ids = [leaveDoc?.id, travel?.id, plan?.id, rules?.id];
    // Cites the plan first, then leave; travel was read, and isn't cited.
    // Each span quotes its document: the plan across a line break, leave
    // once in its words and once in words it doesn't say, the rules not.
    const answer = `It departs at nine [from the depot](grasp:note/${plan?.id} "Departs at nine from the depot."), and leave lasts [sixteen weeks](grasp:note/${leaveDoc?.id} "Parental leave  lasts sixteen weeks."), [paid in full](grasp:note/${leaveDoc?.id} "Leave is paid in full."). Be on time [House rules](grasp:note/${rules?.id}).`;
    /** Where the words `linked` start in the answer as it is stored and shown, its quotes left out. */
    const at = (linked: string): number =>
      answer.replaceAll(/ "[^"]*"\)/gu, ")").indexOf(`[${linked}]`);
    const { ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => { for (const id of ${JSON.stringify(ids)}) { await env.knowledge.read(id); } return "read"; };`
      ),
      says(answer),
      says(answer)
    );
    await grantRead(admin, agent, handbook);
    await grantRead(admin, agent, plans);

    const first = await ask(
      "When does the route depart, and how long is leave?"
    );
    // The person leaves the team: the plan is no longer theirs to read.
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId,
      userId: person.userId,
    });
    const again = await ask("And now?");

    const leaveCited = {
      documentId: leaveDoc?.id,
      collectionId: handbook,
      title: "Parental leave",
      path: "leave.md",
      snippet: "Parental leave lasts sixteen weeks.",
      spans: [
        {
          at: at("sixteen weeks"),
          text: "sixteen weeks",
          // Its whitespace folded, as the document's is.
          quote: "Parental leave lasts sixteen weeks.",
        },
        // Words leave doesn't say: the span cites it, quoting nothing.
        { at: at("paid in full"), text: "paid in full", quote: null },
      ],
    };
    const rulesCited = {
      documentId: rules?.id,
      collectionId: handbook,
      title: "House rules",
      path: "rules.md",
      // Cut to the most a snippet holds, and marked so.
      snippet: `${rule.repeat(20).slice(0, citedSnippetMax - 1)}…`,
      spans: [{ at: at("House rules"), text: "House rules", quote: null }],
    };
    expect({ first: first.cited, again: again.cited }).toStrictEqual({
      first: [
        {
          documentId: plan?.id,
          collectionId: plans,
          title: "Route plan",
          path: "routes/plan.md",
          // Its description, as its author put it.
          snippet: "Where the route goes, and when.",
          spans: [
            {
              at: at("from the depot"),
              text: "from the depot",
              quote: "Departs at nine from the depot.",
            },
          ],
        },
        leaveCited,
        rulesCited,
      ],
      // The plan, its span and its quote, gone with the person's access.
      again: [leaveCited, rulesCited],
    });
  });

  it("answers when the documents its answer cites can't be looked up, and the page finds them once they can", async () => {
    const admin = await newAdmin();
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { id: documentId } = await admin.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: leave,
      ifVersion: 0,
    });
    const answer = `Sixteen weeks [Parental leave](grasp:note/${documentId}).`;
    const { reply, release } = pausedReply(says(answer), 1);
    const { agent, gateway, newChat } = await personalChatsOf(
      person.userId,
      codeStep(readCode(documentId)),
      reply
    );
    await grantRead(admin, agent, collectionId);
    const { chat, ask } = await newChat();

    const turn = ask("How long is parental leave?");
    await vi.waitFor(
      () => {
        expect(gateway.requests).toHaveLength(2);
      },
      { timeout: 10_000 }
    );
    // Knowledge's database fails while the model is still answering.
    await env.KNOWLEDGE.prepare(
      "ALTER TABLE sections RENAME TO sections_away"
    ).run();
    try {
      release();
      await expect(turn).resolves.toStrictEqual({
        outcome: "answered",
        answer,
        provenance: { sources: [collectionId], restricted: false },
        cited: [],
        check: null,
        channelText: null,
      });
    } finally {
      await env.KNOWLEDGE.prepare(
        "ALTER TABLE sections_away RENAME TO sections"
      ).run();
    }

    // The answer was kept, and its page finds what it cites now.
    const sent: ChatMessage[] = [];
    const subscription = await person.api.chats.watch(
      chat.id,
      null,
      (update) => {
        sent.push(...update.messages);
      }
    );
    await vi.waitFor(() => {
      expect(sent.some(({ role }) => role === "assistant")).toBeTruthy();
    });
    await subscription.release();
    const shown = sent.find(
      (message) => message.role === "assistant" && message.text !== ""
    );
    expect({
      text: shown?.role === "assistant" ? shown.text : undefined,
      cited:
        shown === undefined
          ? []
          : await person.api.chats.cited(chat.id, shown.id),
    }).toStrictEqual({
      text: answer,
      cited: [
        {
          documentId,
          collectionId,
          title: "Parental leave",
          path: "leave.md",
          snippet: "Parental leave lasts sixteen weeks.",
          spans: [{ at: 14, text: "Parental leave", quote: null }],
        },
      ],
    });
  });

  it("withholds what an earlier turn read from every later request once its agent may no longer read it, and audits it once", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const secret = `CANARY-${unique()}`;
    const kept = `KEPT-${unique()}`;
    const [plans, handbook] = await Promise.all(
      [
        { name: "Plans", text: `# Route plan\n\nDeparts ${secret}.` },
        { name: "Handbook", text: `# Leave\n\nLeave lasts ${kept}.` },
      ].map(async ({ name, text }) => {
        const { id: collectionId } = await admin.knowledge.createCollection({
          name: `${name} ${unique()}`,
          access: "everyone",
        });
        const { id: documentId } = await admin.knowledge.saveDocument({
          collectionId,
          path: "doc.md",
          text,
          ifVersion: 0,
        });
        return { collectionId, documentId };
      })
    );
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      codeStep(readCode(handbook?.documentId ?? "")),
      says(`Leave lasts ${kept}.`),
      codeStep(readCode(plans?.documentId ?? "")),
      // What the model says after the read repeats it.
      codeStep(`export default async () => ${JSON.stringify(secret)};`),
      says(`It departs ${secret}.`),
      says("I can't read that any more."),
      says("Still not."),
      says(`It departs ${secret}.`)
    );
    const grant = async (collectionId: string) =>
      await requestGranted(
        idp,
        admin,
        readCollection(agent, collectionId, `C${unique()}`.toUpperCase())
      );
    await grant(handbook?.collectionId ?? "");
    const plansGrant = await grant(plans?.collectionId ?? "");

    await ask("How long is leave?");
    await ask("When does the route plan depart?");
    const beforeRevoke = gateway.requests.length;
    await admin.api.permissions.revoke(plansGrant);
    await ask("And now?");
    await ask("And now?");
    const afterRevoke = gateway.requests.slice(beforeRevoke - 1);

    // Sent while it could be read; never once it can't. The other
    // turn's read, still readable, goes on as it was.
    const sent = afterRevoke.map(({ body }) => JSON.stringify(body));
    expect(
      sent.map((body) => ({
        secret: body.includes(secret),
        kept: body.includes(kept),
        result: body.includes(withheldResult),
        response: body.includes(withheldResponse),
      }))
    ).toStrictEqual([
      // The last request before the revocation.
      { secret: true, kept: true, result: false, response: false },
      { secret: false, kept: true, result: true, response: true },
      { secret: false, kept: true, result: true, response: true },
    ]);
    // The transcript keeps it: the person still sees what was said.
    await expect(codeResults(stub, chat.id)).resolves.toContainEqual({
      isError: false,
      text: `Returned:\n# Route plan\n\nDeparts ${secret}.`,
    });

    // Granted again, it may be sent again.
    await grant(plans?.collectionId ?? "");
    await ask("And now?");
    expect(JSON.stringify(gateway.requests.at(-1)?.body)).toContain(secret);

    // Audited once, by the agent for its person: the run and each source
    // (its collection, and the document it read there), never what it read.
    const events = await eventsOf(
      agent.agentId,
      (all) =>
        all.filter(({ action }) => action === "chat.history_withheld").length >=
        2
    );
    const withheld = events
      .filter(({ action }) => action === "chat.history_withheld")
      .toSorted((a, b) =>
        sourceNamed(a.detail.source).localeCompare(sourceNamed(b.detail.source))
      );
    expect(
      withheld.map((event) => ({
        target: event.target,
        source: sourceNamed(event.detail.source),
        run: typeof event.detail.run,
        holdsSecret: JSON.stringify(event).includes(secret),
      }))
    ).toStrictEqual(
      [
        plans?.collectionId ?? "",
        `brain-document:${plans?.collectionId}/${plans?.documentId}`,
      ]
        .toSorted((a, b) => a.localeCompare(b))
        .map((source) => ({
          target: { type: "chat", id: chat.id },
          source,
          run: "string",
          holdsSecret: false,
        }))
    );
  });

  it("withholds what a read or a search handed over once its document is gone, though its collection may still be read", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const readSecret = `READ-${unique()}`;
    const searchWord = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const foundSecret = `FOUND-${unique()}`;
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const [readDoc, searchedDoc] = await Promise.all(
      [
        { path: "read.md", text: `# Read\n\nThe code is ${readSecret}.` },
        {
          path: "found.md",
          text: `# Found\n\n${searchWord} is ${foundSecret}.`,
        },
      ].map(
        async ({ path, text }) =>
          await admin.knowledge.saveDocument({
            collectionId,
            path,
            text,
            ifVersion: 0,
          })
      )
    );
    const { ask, agent, chat, gateway } = await chatOf(
      person.userId,
      codeStep(readCode(readDoc?.id ?? "")),
      says("Read it."),
      codeStep(
        `export default async (self, env) => (await env.knowledge.search(${JSON.stringify(searchWord)})).hits.map(({ snippet }) => snippet);`
      ),
      says("Found it."),
      says("Gone.")
    );
    await grantRead(admin, agent, collectionId);
    await ask("What's the code?");
    await ask("Find the word.");
    const before = JSON.stringify(gateway.requests.at(-1)?.body);
    // Erased from Knowledge, as a purge erases them: the collection stays.
    for (const document of [readDoc, searchedDoc]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await env.KNOWLEDGE.prepare("DELETE FROM documents WHERE id = ?")
        .bind(document?.id ?? "")
        .run();
    }
    await ask("And now?");
    const after = JSON.stringify(gateway.requests.at(-1)?.body);
    const events = await eventsOf(agent.agentId, (all) =>
      all.some(({ action }) => action === "chat.history_withheld")
    );

    expect({
      before: {
        read: before.includes(readSecret),
        // What it found, never the search the code asked for.
        searched: before.includes(foundSecret),
      },
      after: {
        read: after.includes(readSecret),
        searched: after.includes(foundSecret),
      },
      sources: events
        .filter(
          ({ action, target }) =>
            action === "chat.history_withheld" && target?.id === chat.id
        )
        .map(({ detail }) => sourceNamed(detail.source))
        .toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      before: { read: true, searched: true },
      after: { read: false, searched: false },
      sources: [
        `brain-document:${collectionId}/${readDoc?.id}`,
        `brain-document:${collectionId}/${searchedDoc?.id}`,
      ].toSorted((a, b) => a.localeCompare(b)),
    });
  });

  it("stops a turn under way once something it read can't be read any more, before its next request", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const teamId = await newTeam(admin, [person]);
    const secret = `CANARY-${unique()}`;
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Plans ${unique()}`,
      access: "teams",
      teams: [teamId],
    });
    const { id: documentId } = await admin.knowledge.saveDocument({
      collectionId,
      path: "plan.md",
      text: `# Route plan\n\nDeparts ${secret}.`,
      ifVersion: 0,
    });
    // Reads the plan, then reads it again until it can't: the person left
    // the team meanwhile. Leaving a team revokes no permission, so the run
    // ends as it ran.
    const { stub, gateway, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const id = ${JSON.stringify(documentId)};
          const first = (await env.knowledge.read(id)).text;
          for (let tries = 0; tries < 100; tries += 1) {
            try { await env.knowledge.read(id); } catch { return first; }
            await new Promise((done) => setTimeout(done, 50));
          }
          return first;
        };`
      ),
      says(`It departs ${secret}.`)
    );
    await requestGranted(
      idp,
      admin,
      readCollection(agent, collectionId, `C${unique()}`.toUpperCase())
    );
    const recorded = async () =>
      await runInDurableObject(
        stub,
        (_, state) =>
          state.storage.sql
            .exec("SELECT count(*) AS n FROM chat_run_sources")
            .one().n
      );

    const asked = outcome(ask("When does the route plan depart?"));
    await vi.waitFor(
      async () => {
        // Its collection, and the document it read there.
        await expect(recorded()).resolves.toBe(2);
      },
      { timeout: 10_000, interval: 50 }
    );
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId,
      userId: person.userId,
    });

    // The provider takes the turn's latest response whole, so nothing of
    // it can be withheld: the turn stops, and nothing more is sent.
    await expect(asked).resolves.toBe("agent.history_revoked");
    expect(gateway.requests).toHaveLength(1);
  });

  it("sends only the latest of its memory and skills: a skill it can no longer read never reaches the model again", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const marker = `SKILL-${unique()}`;
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbooks ${unique()}`,
      access: "everyone",
    });
    await admin.knowledge.saveDocument({
      collectionId,
      path: "route-check/SKILL.md",
      text: `---\nname: route-check\ndescription: Check routes with ${marker}.\n---\n# Route check`,
      ifVersion: 0,
    });
    const { gateway, ask, agent } = await chatOf(
      person.userId,
      says("Noted."),
      says("Noted again.")
    );
    const grant = await requestGranted(
      idp,
      admin,
      readCollection(agent, collectionId, `C${unique()}`.toUpperCase())
    );
    await ask("Hello.");
    await admin.api.permissions.revoke(grant);
    await ask("Hello again.");

    expect(
      gateway.requests.map(({ body }) => JSON.stringify(body).includes(marker))
    ).toStrictEqual([true, false]);
  });

  it("records nothing for a code run that isn't open", async () => {
    const person = await newPerson();
    const { stub, chat, ask, agent } = await chatOf(person.userId, says("Hi."));

    await expect(
      stub.recordSources(chat.id, crypto.randomUUID(), ["collection-1"])
    ).resolves.toBe("ended");
    await ask("Hi.");

    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 1
    );
    expect(
      modelCalls(events).map(({ provenance }) => provenance)
    ).toStrictEqual([[]]);
  });

  it("recalls for a chat only under the Brain permission, only from what its person may read, and labels the chat with every collection it read, found or not", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    // Granted and readable by the person, but without the word.
    const { id: handbook } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    await admin.knowledge.saveDocument({
      collectionId: handbook,
      path: "other.md",
      text: "# Other\nNothing of it here.",
      ifVersion: 0,
    });
    // Granted, holding the word, but a team's the person isn't in.
    const team = await newTeam(admin, [admin]);
    const { id: teamOnly } = await admin.knowledge.createCollection({
      name: `Team ${unique()}`,
      access: "teams",
      teams: [team],
    });
    await admin.knowledge.saveDocument({
      collectionId: teamOnly,
      path: "plan.md",
      text: `# Plan\n${word}`,
      ifVersion: 0,
    });
    // Readable by the person, holding the word, but never granted.
    const { id: ungranted } = await admin.knowledge.createCollection({
      name: `Ungranted ${unique()}`,
      access: "everyone",
    });
    await admin.knowledge.saveDocument({
      collectionId: ungranted,
      path: "plan.md",
      text: `# Plan\n${word}`,
      ifVersion: 0,
    });
    const asked = (collectionIds?: string[]) =>
      `outcome(env.brain.recall(${JSON.stringify({ query: word, ...(collectionIds === undefined ? {} : { filters: { collectionIds } }) })}))`;
    const recallStep = codeStep(
      `export default async (self, env) => { const outcome = async (pending) => { try { const pack = await pending; return pack.items.length; } catch (error) { return error.code ?? String(error); } }; return [await ${asked()}, await ${asked([handbook])}, await ${asked([ungranted])}, await ${asked([teamOnly])}]; };`
    );
    const { stub, chat, ask, agent } = await chatOf(
      person.userId,
      recallStep,
      says("Nothing."),
      recallStep,
      says("Still nothing."),
      recallStep,
      says("Refused.")
    );
    await grantRead(admin, agent, handbook);
    await grantRead(admin, agent, teamOnly);
    // Without the Brain permission: refused.
    const before = await ask("What is the plan?");
    const brainGrant = await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const after = await ask("What is the plan, now?");
    // Revoked: refused again, from the next call.
    await admin.api.permissions.revoke(brainGrant);
    await ask("And now?");
    const results = await codeResults(stub, chat.id);
    expect({
      results: results.map(({ text }) => text),
      before: before.provenance,
      after: after.provenance,
    }).toStrictEqual({
      results: [
        'Returned:\n["brain.denied","brain.denied","brain.denied","brain.denied"]',
        // Once granted, the turn recalls for the question first: never
        // from the plan its person can't read.
        expect.not.stringContaining(word),
        // Never wider than its grants, nor than what its person may read:
        // naming either is refused as not found.
        'Returned:\n[0,0,"brain.not_found","brain.not_found"]',
        'Returned:\n["brain.denied","brain.denied","brain.denied","brain.denied"]',
      ],
      before: { sources: [], restricted: false },
      // The word is only in a collection the person can't read; the
      // collection it was told to read is the chat's source even though
      // nothing was found there.
      after: { sources: [handbook], restricted: false },
    });
  });
});

/** Grants `agent` the Brain permission, as an admin would. */
const grantBrain = async (
  admin: Admin,
  agent: { type: "agent"; agentId: string }
) =>
  await requestGranted(idp, admin, {
    subject: agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });

/** A message of an Anthropic request, as the gateway was sent it. */
const requestMessagesSchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([z.string(), z.array(z.unknown())]),
    })
  ),
});

/**
 * What a request handed the model as code results (tool results), and
 * everything else it sent: the system prompt, the question, the calls.
 */
const splitRequest = (body: unknown) => {
  const parsed = requestMessagesSchema.parse(body);
  const results: unknown[] = [];
  const rest: unknown[] = [];
  for (const { content } of parsed.messages) {
    for (const block of typeof content === "string" ? [content] : content) {
      const isResult =
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_result";
      (isResult ? results : rest).push(block);
    }
  }
  const { messages: _messages, ...envelope } = z
    .looseObject({ messages: z.unknown() })
    .parse(body);
  return {
    results: JSON.stringify(results),
    rest: JSON.stringify([envelope, rest]),
  };
};

describe("a chat's recall before a question", setUpTime, () => {
  it("hands the model what the Brain recalls for the question, as a code result it reads as data, before its first request", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = "The depot opens at seven";
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { id: documentId } = await admin.knowledge.saveDocument({
      collectionId,
      path: "depot.md",
      text: `# Depot ${word}\n\n${fact}.`,
      ifVersion: 0,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      says("Seven.")
    );
    await grantRead(admin, agent, collectionId);
    await grantBrain(admin, agent);

    const reply = await ask(word);

    const [request] = gateway.requests.map(({ body }) => splitRequest(body));
    const [result] = await codeResults(stub, chat.id);
    expect({
      answer: reply.answer,
      requests: gateway.requests.length,
      inResult: request?.results.includes(fact),
      elsewhere: request?.rest.includes(fact),
      cites: result?.text.includes(documentId),
      provenance: reply.provenance,
    }).toStrictEqual({
      answer: "Seven.",
      // Answered from the evidence, without a search of its own.
      requests: 1,
      inResult: true,
      elsewhere: false,
      cites: true,
      provenance: { sources: [collectionId], restricted: false },
    });
    // Audited as the agent's recall: a read of what it returned.
    const events = await eventsOf(agent.agentId, (all) =>
      all.some(({ action }) => action === "knowledge.search")
    );
    expect(
      events
        .filter(({ action }) => action === "knowledge.search")
        .map(({ detail }) => detail)
    ).toStrictEqual([expect.objectContaining({ via: "recall", hits: 1 })]);
  });

  it("never hands the model what the person or the agent may not read", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const teamCanary = `team canary ${unique()}`;
    const ungrantedCanary = `ungranted canary ${unique()}`;
    // Granted to the agent, but a team's the person isn't in.
    const team = await newTeam(admin, [admin]);
    const { id: teamOnly } = await admin.knowledge.createCollection({
      name: `Team ${unique()}`,
      access: "teams",
      teams: [team],
    });
    await admin.knowledge.saveDocument({
      collectionId: teamOnly,
      path: "plan.md",
      text: `# Plan ${word}\n\n${teamCanary}`,
      ifVersion: 0,
    });
    // Readable by the person, but not granted to the agent.
    const { id: ungranted } = await admin.knowledge.createCollection({
      name: `Open ${unique()}`,
      access: "everyone",
    });
    await admin.knowledge.saveDocument({
      collectionId: ungranted,
      path: "plan.md",
      text: `# Plan ${word}\n\n${ungrantedCanary}`,
      ifVersion: 0,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      says("I can't find it.")
    );
    await grantRead(admin, agent, teamOnly);
    await grantBrain(admin, agent);

    const reply = await ask(word);

    const sent = JSON.stringify(gateway.requests.map(({ body }) => body));
    const [result] = await codeResults(stub, chat.id);
    expect({
      team: sent.includes(teamCanary),
      ungranted: sent.includes(ungrantedCanary),
      recalled: result?.text.includes('"evidence":[]'),
      provenance: reply.provenance,
    }).toStrictEqual({
      team: false,
      ungranted: false,
      recalled: true,
      provenance: { sources: [], restricted: false },
    });
  });

  it("recalls nothing without the Brain permission", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = `The code is ${unique()}`;
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    await admin.knowledge.saveDocument({
      collectionId,
      path: "code.md",
      text: `# Code ${word}\n\n${fact}.`,
      ifVersion: 0,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      says("Let me look.")
    );
    await grantRead(admin, agent, collectionId);

    const reply = await ask(word);

    expect({
      steps: await codeResults(stub, chat.id),
      sent: JSON.stringify(gateway.requests.map(({ body }) => body)).includes(
        fact
      ),
      provenance: reply.provenance,
    }).toStrictEqual({
      steps: [],
      sent: false,
      provenance: { sources: [], restricted: false },
    });
  });

  it("keeps the recall within what the model takes, for a question near its limit", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    // Five long sections the question's word matches: more evidence than
    // a question near the limit leaves room for.
    for (const index of [1, 2, 3, 4, 5]) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await admin.knowledge.saveDocument({
        collectionId,
        path: `long-${index}.md`,
        text: `# Long ${index}\n\n${`The ${word} rule applies. `.repeat(40)}`,
        ifVersion: 0,
      });
    }
    // The model that takes 18,000 tokens: its window of 24,000 less a
    // quarter kept for the answer (agent.test.ts).
    const tiny = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const { stub, chat, gateway, agent } = await chatOf(
      person.userId,
      says("Near the limit."),
      says("With room.")
    );
    await pointAtGateway(stub, gateway, {
      config: { ...gatewayConfig, models: [model, tiny] },
    });
    await grantRead(admin, agent, collectionId);
    await grantBrain(admin, agent);
    const question = (chars: number) =>
      `${word} ${"x".repeat(chars - word.length - 1)}`;
    // The longest question the model takes, to within a thousand
    // characters: a longer one is refused before anything runs.
    let chars = 54_000;
    let near: Awaited<ReturnType<typeof stub.ask>> | undefined;
    const refusals = new Set<string | undefined>();
    while (near === undefined) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- shorter until one fits
        near = await stub.ask(chat.id, { text: question(chars), model: tiny });
      } catch (error) {
        refusals.add(agentErrors.codeOf(error));
        chars -= 1000;
      }
    }
    const nearSteps = await codeResults(stub, chat.id);
    const withRoom = await stub.ask(chat.id, {
      text: question(chars - 12_000),
      model: tiny,
    });
    const steps = await codeResults(stub, chat.id);
    const window = requestChars(18_000);
    expect({
      refusals: [...refusals],
      near: near.outcome,
      nearSteps,
      nearFits: JSON.stringify(gateway.requests[0]?.body).length <= window,
      withRoom: withRoom.outcome,
      recalled: steps.at(-1)?.text.includes(`"evidence":[{`),
      fits: JSON.stringify(gateway.requests[1]?.body).length <= window,
    }).toStrictEqual({
      refusals: ["agent.question_too_long"],
      near: "answered",
      // No room left for evidence: no recall.
      nearSteps: [],
      nearFits: true,
      withRoom: "answered",
      // Evidence, as much as fits.
      recalled: true,
      fits: true,
    });
  });

  it("answers without evidence, told why, when the recall runs out of time", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = `The code is ${unique()}`;
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    await admin.knowledge.saveDocument({
      collectionId,
      path: "code.md",
      text: `# Code ${word}\n\n${fact}.`,
      ifVersion: 0,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      says("I couldn't read Knowledge in time.")
    );
    await grantRead(admin, agent, collectionId);
    await grantBrain(admin, agent);
    // Too short for any run to finish: only for this test's turn.
    const restore = await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1" });
    let reply: Awaited<ReturnType<typeof ask>>;
    try {
      reply = await ask(word);
    } finally {
      await restore();
    }

    const [request] = gateway.requests.map(({ body }) => splitRequest(body));
    expect({
      outcome: reply.outcome,
      statuses: await codeStatuses(stub, chat.id),
      told: request?.results.includes("wall_expired"),
      sent: JSON.stringify(gateway.requests.map(({ body }) => body)).includes(
        fact
      ),
    }).toStrictEqual({
      outcome: "answered",
      statuses: ["wall_expired"],
      told: true,
      sent: false,
    });
  });

  it("withholds what a recall handed over once its document is gone or purged, or the Brain permission is revoked, though its collection may still be read, and audits it", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    /** A chat whose first turn recalled `fact`, from a collection it keeps. */
    const recalled = async () => {
      const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
      const code = `depot${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
      const fact = `The depot code is ${code}`;
      const { id: collectionId } = await admin.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const { id: documentId } = await admin.knowledge.saveDocument({
        collectionId,
        path: "depot.md",
        text: `# Depot ${word}\n\n${fact}.`,
        ifVersion: 0,
      });
      const chat = await chatOf(
        person.userId,
        says("Noted."),
        says("And again.")
      );
      await grantRead(admin, chat.agent, collectionId);
      const brainGrant = await grantBrain(admin, chat.agent);
      await chat.ask(word);
      /** Whether the next turn's first request still sent the fact. */
      const next = async () => {
        const before = chat.gateway.requests.length;
        await chat.ask("And the code?");
        const body = JSON.stringify(chat.gateway.requests[before]?.body);
        return {
          fact: body.includes(fact),
          withheld: body.includes(withheldResult),
        };
      };
      return { ...chat, code, collectionId, documentId, brainGrant, next };
    };
    /** The sources of the chat's `chat.history_withheld` events. */
    const withheldOf = async (agentId: string, chatId: string) => {
      const events = await eventsOf(agentId, (all) =>
        all.some(({ action }) => action === "chat.history_withheld")
      );
      return events
        .filter(
          ({ action, target }) =>
            action === "chat.history_withheld" && target?.id === chatId
        )
        .map(({ detail }) => sourceNamed(detail.source));
    };

    const kept = await recalled();
    const unchanged = await kept.next();
    const erased = await recalled();
    // Erased from the Brain, as a purge erases it: its collection stays.
    await env.KNOWLEDGE.prepare("DELETE FROM documents WHERE id = ?")
      .bind(erased.documentId)
      .run();
    const afterErase = await erased.next();
    const purged = await recalled();
    // Purged from it: the document stays, in its collection, at a new
    // version, without the code.
    const purge: PurgeInput = {
      type: "content",
      documentIds: [purged.documentId],
      terms: [purged.code],
      reason: "erasure_request",
    };
    const plan = await admin.knowledge.preparePurge(purge);
    await admin.knowledge.purge(purge, plan.token);
    const afterPurge = await purged.next();
    const revoked = await recalled();
    await admin.api.permissions.revoke(revoked.brainGrant);
    const afterRevoke = await revoked.next();

    expect({
      unchanged,
      afterErase,
      afterPurge,
      afterRevoke,
      erasedSources: await withheldOf(erased.agent.agentId, erased.chat.id),
      purgedSources: await withheldOf(purged.agent.agentId, purged.chat.id),
      revokedSources: await withheldOf(revoked.agent.agentId, revoked.chat.id),
    }).toStrictEqual({
      // Still readable: the next turn sends what the first recalled.
      unchanged: { fact: true, withheld: false },
      afterErase: { fact: false, withheld: true },
      afterPurge: { fact: false, withheld: true },
      afterRevoke: { fact: false, withheld: true },
      // Named by its IDs, never by what it said.
      erasedSources: [
        `brain-document:${erased.collectionId}/${erased.documentId}`,
      ],
      purgedSources: [
        `brain-document:${purged.collectionId}/${purged.documentId}`,
      ],
      revokedSources: ["brain-grant"],
    });
  });
});
