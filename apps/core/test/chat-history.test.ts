import type { AuditEvent } from "@grasp-os/shared/audit";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { withheldResponse, withheldResult } from "../src/agent.ts";
import { addSource } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { workspace } from "../src/durable-objects.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { outcome, signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// What a chat's code read, kept with the chat: what every later model
// request of the chat is judged by, and withheld from once it can't be
// read. These tests start from the ways it can fail: a run of a code run
// that ended is still recorded; a chat recalls from the Brain without the
// permission, or past what its person may read; and a run whose history
// pins what core no longer checks (today's Knowledge, which the Brain
// replaced) is still sent to the model.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A member of the organization, whom no other test uses: the chat's person. */
const newPerson = async () => await signedInWithRole(idp, "user");

type Admin = Awaited<ReturnType<typeof signedInApi>>;

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

/** A source in the Brain that `readers` may read. */
const inBrain = async (text: string, readers: SourceReaders) => {
  const source = { producer: "upload" as const, id: crypto.randomUUID() };
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
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

const modelCalls = (events: AuditEvent[]) =>
  events.filter(({ action }) => action === "model.call");

describe("a chat's history", setUpTime, () => {
  it("makes no chat for an agent whose ID isn't a plain identifier", async () => {
    const person = await newPerson();
    const stub = workspace(env, workspaceIdSchema.parse(crypto.randomUUID()));
    // What no agent core names looks like: it would reach into another
    // agent's memory path.
    await expect(
      outcome(stub.createChat("Questions", person.userId, "../other"))
    ).resolves.toBe("permission.context_invalid");
  });

  it("records nothing for a code run that isn't open", async () => {
    const person = await newPerson();
    const { stub, chat, ask, agent } = await chatOf(person.userId, says("Hi."));

    await expect(
      stub.recordSources(chat.id, crypto.randomUUID(), ["connection-1"])
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

  // A run an earlier release kept as having read a Knowledge collection,
  // or a document version it was handed there: nothing checks either now,
  // so it can never be shown readable again. Withheld, as any pin no check
  // confirms (history-access.ts), never sent.
  it("withholds a run whose history pins a Knowledge collection or document from every later request, and audits it once", async () => {
    const person = await newPerson();
    const suffix = unique();
    const secret = `CANARY-${suffix}`;
    const { id, stub, chat, provider, ask, agent } = await chatOf(
      person.userId,
      // Its result holds the secret; its code doesn't spell it.
      codeStep(
        `export default async () => ["CANARY", ${JSON.stringify(suffix)}].join("-");`
      ),
      says(`It departs ${secret}.`),
      says("I can't read that any more."),
      says("Still not.")
    );
    await ask("When does the route plan depart?");
    const sentBefore = JSON.stringify(provider.requests.at(-1)?.body);
    await runInDurableObject(stub, (_instance, state) => {
      const { run } = state.storage.sql
        .exec<{ run: string }>(
          "SELECT id AS run FROM chat_code_runs WHERE chat_id = ?",
          chat.id
        )
        .one();
      for (const source of [
        "handbook",
        `brain-document:${JSON.stringify(["handbook", "doc-1", 1, "Departs"])}`,
      ]) {
        state.storage.sql.exec(
          "INSERT INTO chat_run_sources (chat_id, run_id, source_id, withheld_at) VALUES (?, ?, ?, NULL)",
          chat.id,
          run,
          source
        );
      }
    });
    const afterPins = provider.requests.length;

    await ask("And now?");
    await ask("And now?");
    const results = await codeResults(stub, chat.id);
    const sent = provider.requests
      .slice(afterPins)
      .map(({ body }) => JSON.stringify(body));
    expect({
      before: sentBefore.includes(secret),
      later: sent.map((body) => ({
        secret: body.includes(secret),
        result: body.includes(withheldResult),
        response: body.includes(withheldResponse),
      })),
      // The transcript keeps it: the person still sees what was said.
      transcript: results.some(({ text }) => text.includes(secret)),
    }).toStrictEqual({
      before: true,
      later: [
        { secret: false, result: true, response: true },
        { secret: false, result: true, response: true },
      ],
      transcript: true,
    });

    // Audited once, by the agent for its person: the run and each pin,
    // counted by kind (one no check names is `unknown`), never which.
    const events = await eventsOf(agent.agentId, (all) =>
      all.some(({ action }) => action === "chat.history_withheld")
    );
    expect(
      events
        .filter(({ action }) => action === "chat.history_withheld")
        .map((event) => ({
          target: event.target,
          detail: event.detail,
          holdsSecret: JSON.stringify(event).includes(secret),
        }))
    ).toStrictEqual([
      {
        target: { type: "chat", id: chat.id },
        detail: { workspace: id, runs: 1, sources: 2, unknown: 2 },
        holdsSecret: false,
      },
    ]);
  });

  it("recalls for a chat only under the Brain permission, and only what its person may read", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await newPerson();
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    // A team's, holding the word, and the person isn't in it.
    const team = await newTeam(admin, [admin]);
    await inBrain(`The plan: ${word}.`, { kind: "team", teamId: team });
    // One of a team of the person's, holding it too: the agent's code
    // reads as their teams, never what only they may read (GRA-1762).
    await inBrain(`Our plan: ${word}.`, {
      kind: "team",
      teamId: await newTeam(admin, [person]),
    });
    const recallStep = codeStep(
      `export default async (self, env) => { try { const pack = await env.brain.recall(${JSON.stringify({ question: word, budget: { tokens: 800 } })}); return pack.items.map(({ text }) => text); } catch (error) { return error.code ?? String(error); } };`
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
    // Without the Brain permission: no `env.brain` to call at all.
    await ask("What is the plan?");
    const brainGrant = await grantBrain(admin, agent);
    await ask("What is the plan, now?");
    // Revoked: gone again, from the next turn.
    await admin.api.permissions.revoke(brainGrant);
    await ask("And now?");
    const results = await codeResults(stub, chat.id);
    expect(results.map(({ text }) => text)).toStrictEqual([
      expect.stringContaining("This chat has no API named env.brain"),
      // Once granted, the code's own: their own plan, never the team's.
      `Returned:\n["Our plan: ${word}."]`,
      expect.stringContaining("This chat has no API named env.brain"),
    ]);
  });
});
