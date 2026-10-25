import { lessonsOf } from "@grasp-os/brain/lessons";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { scheduleConsolidation } from "../src/brain-consolidation.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { projectStatus } from "../src/workflows/runs.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import { workflowFiles, workflowsApp } from "./workflow-apps.ts";

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

/** A published App of a new builder's. */
const publishedApp = async () => {
  const builder = await signedInApi(idp, "builder");
  const app = await workflowsApp(
    builder,
    workflowFiles(
      "tidy",
      `return await step.do("one", { description: "Tidy up" }, async () => 1);`,
      { one: 1 }
    )
  );
  return { builder, app };
};

/** A run of `app`'s by `startedBy` that failed, as the engine reports it. */
const failedRun = async (app: string, startedBy: string): Promise<string> => {
  const run = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'tidy', 1, ?, 'running', ?)"
  )
    .bind(run, app, startedBy, Date.now())
    .run();
  await projectStatus(env, run, {
    status: "errored",
    at: Date.now(),
    sequence: 9,
  });
  return run;
};

/** Once the Brain holds `count` of the person's episodes. */
const episodesHeld = async (userId: string, count: number) => {
  await vi.waitFor(
    async () => {
      const { results } = await env.KNOWLEDGE.prepare(
        "SELECT id FROM brain_episodes WHERE owner_id = ?"
      )
        .bind(userId)
        .all();
      expect(results.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 15_000, interval: 100 }
  );
};

describe(
  "consolidating ordinary work into lesson candidates",
  setUpTime,
  () => {
    it("turns an App's repeated failures into a candidate for its person alone, once, with no learning step in the task", async () => {
      const { builder, app } = await publishedApp();
      const other = await signedInApi(idp, "builder");
      const runs = [
        await failedRun(app, builder.userId),
        await failedRun(app, builder.userId),
        await failedRun(app, builder.userId),
      ];
      await episodesHeld(builder.userId, runs.length);
      const scope = { scope: "person" as const, scopeId: builder.userId };

      await vi.waitFor(
        async () => {
          const lessons = await lessonsOf(brainOf(env), scope);
          expect(lessons).toHaveLength(1);
        },
        { timeout: 15_000, interval: 200 }
      );
      // Scheduled again, as a late delivery or the clock would: the same
      // job, and nothing new to write.
      await scheduleConsolidation(env, scope);
      const [lesson] = await lessonsOf(brainOf(env), scope);
      const othersLessons = await lessonsOf(brainOf(env), {
        scope: "person",
        scopeId: other.userId,
      });
      const { results: jobIntents } = await env.DB.prepare(
        "SELECT evidence_id FROM brain_capture_intents WHERE evidence_id NOT IN (SELECT id FROM workflow_runs)"
      ).all();

      expect({
        state: lesson?.state,
        revisions: lesson?.versions.length,
        supporting: lesson?.versions.at(-1)?.content.supporting.length,
        others: othersLessons.length,
        // The consolidation job has no run row: nothing of it is captured.
        jobIntents: jobIntents.length,
      }).toStrictEqual({
        state: "candidate",
        revisions: 1,
        supporting: 3,
        others: 0,
        jobIntents: 0,
      });
    });
  }
);
