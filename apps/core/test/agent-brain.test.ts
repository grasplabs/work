import type { AuditEvent } from "@grasp-os/shared/audit";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { describe, expect, it, vi } from "vite-plus/test";

import { codeResults, codeStep, personalChatsOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

// The company brain for a chat's code (`env.brain`): read as the chat's
// person, only once the agent holds the brain permission (a platform
// permission, `brain`), and every call recorded as the chat's agent's.
// Its open questions are the Playbook's gaps (GRA-527): an answered or
// closed one is no longer open, and an answer never reaches the agent.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** What `env.brain.gaps()` answered, or the message it was refused with. */
const askGaps = codeStep(
  "export default async (self, env) => { try { return await env.brain.gaps(); } catch (error) { return error.message; } };"
);

/** The chat agent's `brain.gaps` calls, once `count` are recorded. */
const gapCalls = async (
  agentId: string,
  count: number
): Promise<AuditEvent[]> =>
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      const calls = events.filter(
        ({ actor, action, detail }) =>
          action === "agent.call" &&
          detail.method === "brain.gaps" &&
          actor.type === "agent" &&
          actor.agentId === agentId
      );
      expect(calls).toHaveLength(count);
      return calls;
    },
    { timeout: 10_000, interval: 50 }
  );

describe("a chat's brain", setUpTime, () => {
  it("reads its open questions only once the agent holds the brain permission, and records every read", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      askGaps,
      says("None I can see."),
      askGaps,
      says("None open.")
    );
    const before = await newChat();
    await before.ask("What's still unknown?");
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const after = await newChat();
    await after.ask("What's still unknown?");

    const calls = await gapCalls(agent.agentId, 2);
    const beforeSteps = await codeResults(stub, before.chat.id);
    // Once granted, the turn recalls for the question before the model's
    // first request (agent.ts): its own code step, then the model's.
    const [recalled, read] = await codeResults(stub, after.chat.id);
    expect({
      before: beforeSteps.map(({ text }) => text),
      recalled: recalled?.text.startsWith('Returned:\n{"note":'),
      after: read?.text,
      calls: calls.map(({ actor, detail }) => ({
        onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
        outcome: detail.outcome,
        reason: detail.reason,
      })),
    }).toStrictEqual({
      // Without the permission, no recall step: only the model's.
      before: [
        `Returned:\n${permissionErrors.create("permission.denied", { action: "read" }).message}`,
      ],
      recalled: true,
      after: "Returned:\n[]",
      calls: [
        {
          onBehalfOf: person.userId,
          outcome: "refused",
          reason: "permission.denied",
        },
        { onBehalfOf: person.userId, outcome: "ok", reason: null },
      ],
    });
  });

  it("reads the questions still open as the person, and none of an answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const records: BrainRecordInput[] = [
      {
        type: "source",
        id: "src-agent",
        kind: "interview",
        title: "Finance interview",
        date: "2026-10-20",
      },
      {
        type: "gap",
        id: "gap-open",
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: "src-agent",
        about: [],
      },
      {
        type: "gap",
        id: "gap-answered",
        question: "Who approves a refund?",
        owner: "Head of finance",
        sourceId: "src-agent",
        about: [],
      },
    ];
    await admin.api.brain.addRecords(records);
    const secret = "Refunds go through Ann, cell 555 0100.";
    await member.api.brain.answerGap("gap-answered", secret);
    const { stub, agent, newChat } = await personalChatsOf(
      member.userId,
      askGaps,
      says("One is open.")
    );
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const { chat, ask } = await newChat();
    await ask("What's still unknown?");

    // The recall before the first request, then the model's own read.
    const [recalled, read] = await codeResults(stub, chat.id);
    const text = read?.text ?? "";
    expect(recalled?.text).not.toContain(secret);
    expect(text).not.toContain(secret);
    expect(JSON.parse(text.replace(/^Returned:\n/u, ""))).toStrictEqual([
      {
        id: "gap-open",
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: "src-agent",
        about: [],
      },
    ]);
  });
});
