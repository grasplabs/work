import { consolidate, lessonsOf } from "@grasp-os/brain/lessons";
import { recordOutcome } from "@grasp-os/brain/outcomes";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { eraseCaptured } from "../src/brain-capture.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// Lesson candidates from ordinary work (GRA-301; the design and its ways
// to fail are on the issue): an App's runs end, their outcomes are
// captured (brain-capture.ts), and once a scope has enough new episodes
// the Brain consolidates them in a job of core's own, with no learning
// step in any task. Tried below: that ordinary failures become a
// candidate in their person's scope alone; that scheduling it again is
// the same job and writes nothing twice; and that the job's own work is
// never captured as experience.

const idp = mockIdp();

/** Signing in and publishing an App can be slow on CI. */
const setUpTime = { timeout: 60_000 };

describe(
  "consolidating ordinary work into lesson candidates",
  setUpTime,
  () => {
    it("retires a shared chat's lesson when the chat is deleted, with no job after", async () => {
      const ann = await signedInApi(idp, "user");
      const ben = await signedInApi(idp, "user");
      const chatId = crypto.randomUUID();
      const brain = brainOf(env);
      for (let n = 0; n < 3; n += 1) {
        const turn = crypto.randomUUID();
        // oxlint-disable-next-line no-await-in-loop -- turns settle in order
        await recordOutcome(brain, {
          eventId: `chat.turn:${chatId}:${turn}`,
          source: `chat.turn:test-${chatId}`,
          sourceSeq: n + 1,
          purpose: "production",
          ownerId: ann.userId,
          scope: "session",
          audience: { id: chatId, members: [ann.userId, ben.userId] },
          taskType: "chat.turn",
          execution: "failed",
          result: "failure",
          evidenceId: chatId,
          evidenceRefs: [{ kind: "chat_turn", id: turn }],
          versionRefs: [],
          occurredAt: new Date().toISOString(),
        });
      }
      const scope = { scope: "session" as const, scopeId: chatId };
      await consolidate(brain, scope);
      const [before] = await lessonsOf(brain, scope);

      // What deleting the chat erases (workspace.ts).
      await eraseCaptured(env, [chatId]);
      const [after] = await lessonsOf(brain, scope);

      expect({
        before: before?.state,
        after: after?.state,
        retiredBy: after?.retiredBy,
      }).toStrictEqual({
        before: "candidate",
        after: "retired",
        retiredBy: "evidence",
      });
    });
  }
);
