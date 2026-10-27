import { brainErrors } from "@grasp-os/brain/contract";
import { consolidate } from "@grasp-os/brain/lessons";
import { recordOutcome } from "@grasp-os/brain/outcomes";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { keepAudience } from "../src/knowledge/access.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Lessons through Knowledge's RPC, as the Brain's Memory page reads them
// (GRA-301, slice 2; the threat model is on the issue): a shared chat's
// lesson for the people who were in it for every turn it rests on and
// still are, retired only by one of the company's admins among them.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The code `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

/** The lessons `person` lists. */
const listed = async (person: Person): Promise<string[]> => {
  const lessons = await person.api.knowledge.lessonsList();
  return lessons.map(({ id }) => id);
};

describe("lessons through Knowledge's RPC", setUpTime, () => {
  it("shows a shared chat's lesson to the people there for every turn it rests on, and lets an admin among them retire it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ben = await signedInApi(idp, "user");
    const cas = await signedInApi(idp, "user");
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const chat = await newChat(agent);
    const members = [admin.userId, ben.userId];
    await keepAudience(env, chat, admin.userId, {
      members,
      outsiders: false,
    });
    const brain = brainOf(env);
    for (let n = 0; n < 3; n += 1) {
      const turn = crypto.randomUUID();
      // oxlint-disable-next-line no-await-in-loop -- turns settle in order
      await recordOutcome(brain, {
        eventId: `chat.turn:${chat.chatId}:${turn}`,
        source: `chat.turn:test-${chat.chatId}`,
        sourceSeq: n + 1,
        purpose: "production",
        ownerId: admin.userId,
        scope: "session",
        audience: { id: chat.chatId, members },
        taskType: "chat.turn",
        execution: "failed",
        result: "failure",
        evidenceId: chat.chatId,
        evidenceRefs: [{ kind: "chat_turn", id: turn }],
        versionRefs: [],
        occurredAt: new Date().toISOString(),
      });
    }
    await consolidate(brain, { scope: "session", scopeId: chat.chatId });
    // Cas joins after every turn the lesson rests on.
    await keepAudience(env, chat, admin.userId, {
      members: [...members, cas.userId],
      outsiders: false,
    });
    const [lessonId = ""] = await listed(ben);
    const retire = async (by: Person) =>
      await outcome(
        by.api.knowledge.lessonsRetire({ lessonId, expectedRevision: 1 })
      );

    const before = {
      admin: await listed(admin),
      ben: [lessonId],
      cas: await listed(cas),
      casLineage: await outcome(cas.api.knowledge.lessonsLineage({ lessonId })),
    };
    const byBen = await retire(ben);
    const byCas = await retire(cas);
    const byAdmin = await retire(admin);
    const lineage = await ben.api.knowledge.lessonsLineage({ lessonId });

    expect({
      before,
      byBen,
      byCas,
      byAdmin,
      state: lineage.lesson.state,
      revisions: lineage.versions.map(({ revision }) => revision),
    }).toStrictEqual({
      before: {
        admin: [lessonId],
        ben: [lessonId],
        cas: [],
        casLineage: "brain.not_found",
      },
      // Not an admin: a shared lesson isn't his to retire.
      byBen: "brain.not_found",
      byCas: "brain.not_found",
      byAdmin: "ok",
      state: "retired",
      revisions: [2, 1],
    });
  });
});
