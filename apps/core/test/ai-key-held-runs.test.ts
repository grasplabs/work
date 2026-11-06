import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { wakeAiWaits } from "../src/workflows/ai-waits.ts";
import { mockIdp } from "./idp.ts";
import {
  askedModel,
  askingWorkflow,
  askTask,
  endedRun,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  runFor,
  runOnce,
  settles,
  startedBy,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";

// A JSON workflow's model call when the organization's own AI provider
// fails it: it refuses the key (401/403), it isn't answering (5xx, an
// outage), or it is limiting requests (429, a rate or spending limit). A
// call bound to its model never falls back to another, so the run must
// neither fail nor spend its tries on a provider that may come back. The
// ways it can fail come first: it waits for good, unseen; it waits on
// after the key is replaced, for someone to restart it; it keeps showing
// the wait once its call failed for another reason; it waits past any
// deadline. The provider behind connect is the outside system
// (test/model-provider.ts); the rest is real, down to the engine's durable
// waits and wakes.
//
// A run held while the key is refused and going on once an admin replaces
// it, and one held through an outage going on by itself, are
// workflow-calls' "waits while the provider refuses the key…" and "waits
// while the provider fails its call with a 5xx…".

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/** What the provider answers while it fails, by what it shows. */
const failures: Readonly<Record<ProviderTrouble, ProviderReply>> = {
  refused: {
    status: 401,
    body: {
      type: "error",
      error: { type: "authentication_error", message: "invalid api key" },
    },
  },
  not_answering: { status: 503, errorType: "overloaded_error" },
  // An account at its spending limit: never waited out as a rate limit,
  // which the gateway retries within the attempt when its wait fits.
  limiting: {
    status: 429,
    body: {
      error: {
        type: "insufficient_quota",
        code: "insufficient_quota",
        message: "You exceeded your current quota.",
      },
    },
  },
};

/** The call's answer, once calls work. */
const line: ProviderReply = {
  text: '{ "line": "Hello Ada" }',
  inputTokens: 10,
  outputTokens: 5,
};

/**
 * A workflow of a builder's that asks its model, running `tasks` and
 * ending with `status` if given; the provider failing as `shows` says
 * until `provider.working`, then answering `answer`, counting what it was
 * asked.
 */
const heldWorkflow = async (
  provider: { working: boolean; asked: number },
  shows: ProviderTrouble,
  {
    tasks,
    status,
    answer = line,
  }: { tasks?: unknown[]; status?: unknown; answer?: ProviderReply } = {}
) => {
  const admin = await signedIn("admin");
  const builder = await signedIn("builder");
  const fake = await answeringProvider(
    () => {
      provider.asked += 1;
      return provider.working ? answer : failures[shows];
    },
    { models: [askedModel] }
  );
  const { id } = await askingWorkflow(
    admin,
    builder,
    tasks,
    askedModel,
    status
  );
  return { admin, builder, fake, id };
};

/** What run `runId` of workflow `id` says it waits for, once it waits for its AI provider. */
const waitingFor = async (by: Person, id: string, runId: string) => {
  const run = await runOnce(
    by,
    id,
    runId,
    ({ aiProvider }) => aiProvider !== undefined
  );
  return {
    status: run.status,
    provider: run.aiProvider?.provider,
    trouble: run.aiProvider?.trouble,
  };
};

/** Sets the deployment's `name` to `value` for `run`, then back. */
const withEnv = async <T>(
  name: "WORKFLOW_OFF_WAIT_MS" | "WORKFLOW_AI_KEY_HOLD_MS",
  value: string,
  run: () => Promise<T>
): Promise<T> => {
  const before = env[name];
  env[name] = value;
  try {
    return await run();
  } finally {
    env[name] = before;
  }
};

describe(
  "a JSON workflow's model call when the organization's AI provider fails it",
  { timeout: 90_000 },
  () => {
    afterEach(endLiveResourceRuns);

    it("stops showing the run as waiting once its call, made again after the wait, fails and the workflow takes the failure", async () => {
      // Timed tries a minute apart: only the replacement's wake can resume
      // the run within the test.
      const result = await withEnv(
        "WORKFLOW_OFF_WAIT_MS",
        "59000",
        async () => {
          const provider = { working: false, asked: 0 };
          // Made again, the call answers, but nothing its schema takes: it
          // fails for good, and the workflow takes the failure and rests.
          const { admin, builder, fake, id } = await heldWorkflow(
            provider,
            "refused",
            {
              answer: {
                text: "No line here.",
                inputTokens: 10,
                outputTokens: 5,
              },
              tasks: [
                {
                  id: "guard",
                  type: "try",
                  try: [askTask],
                  catch: { do: [{ id: "rest", type: "wait", for: "1 day" }] },
                },
              ],
              status: "rested",
            }
          );
          const runId = await startedBy(builder, id);
          const held = await waitingFor(builder, id, runId);
          provider.working = true;
          await admin.api.aiProviders.add({
            provider: "mistral",
            key: fake.key,
          });
          // Once the call took its failure, the run rests, still under way.
          await vi.waitFor(() => {
            expect(provider.asked).toBeGreaterThanOrEqual(2);
          }, settles);
          const after = await runOnce(
            builder,
            id,
            runId,
            ({ aiProvider }) => aiProvider === undefined
          );
          await builder.api.workflowResources.terminateRun(id, runId);
          return { held, after };
        }
      );

      expect({
        held: result.held,
        status: result.after.status,
        waitingFor: result.after.aiProvider,
      }).toStrictEqual({
        held: { status: "running", provider: "mistral", trouble: "refused" },
        // Resting, as its workflow said: not waiting for the provider.
        status: "running",
        waitingFor: undefined,
      });
    });

    it("wakes every held run once a key is replaced, however many, reading them a page at a time", async () => {
      const result = await withEnv(
        "WORKFLOW_OFF_WAIT_MS",
        "59000",
        async () => {
          const provider = { working: false, asked: 0 };
          const { builder, id } = await heldWorkflow(provider, "refused");
          const runs = [
            await startedBy(builder, id),
            await startedBy(builder, id),
            await startedBy(builder, id),
          ];
          for (const runId of runs) {
            // oxlint-disable-next-line no-await-in-loop -- one at a time
            await waitingFor(builder, id, runId);
          }
          provider.working = true;
          // Two held runs a page: three of them take two pages.
          await wakeAiWaits(env, 2);
          const ended = [];
          for (const runId of runs) {
            // oxlint-disable-next-line no-await-in-loop -- one at a time
            ended.push(await endedRun(builder, id, runId));
          }
          return ended.map(({ status }) => status);
        }
      );

      expect(result).toStrictEqual(["completed", "completed", "completed"]);
    });

    it("holds the run while the provider limits requests, and completes by itself once it answers again, each try a request of its own", async () => {
      const provider = { working: false, asked: 0 };
      const { admin, builder, id } = await heldWorkflow(provider, "limiting");
      const runId = await startedBy(builder, id);
      const held = await waitingFor(builder, id, runId);
      // Requests sent while it was held: one per try, never sent again
      // within a try.
      await vi.waitFor(() => {
        expect(provider.asked).toBeGreaterThanOrEqual(2);
      }, settles);
      const { providers } = await admin.api.aiProviders.list();
      // The limit lifts: nobody touches Grasp.
      provider.working = true;
      const run = await endedRun(builder, id, runId);

      expect({
        held,
        shows: providers.find(({ provider: name }) => name === "mistral")
          ?.status?.failingClass,
        done: { status: run.status, output: run.output },
      }).toStrictEqual({
        held: { status: "running", provider: "mistral", trouble: "limiting" },
        shows: "limiting",
        done: { status: "completed", output: { status: "Hello Ada" } },
      });
    });

    it.each([
      ["refused", "model.provider_key_failed"],
      ["not_answering", "model.provider_unavailable"],
      ["limiting", "model.rate_limited"],
    ] as const)(
      "fails the run once it waited as long as a call may, with what the provider showed (%s)",
      async (shows, code) => {
        const run = await withEnv(
          "WORKFLOW_AI_KEY_HOLD_MS",
          "1500",
          async () => {
            const { builder, id } = await heldWorkflow(
              { working: false, asked: 0 },
              shows
            );
            const runId = await startedBy(builder, id);
            await endedRun(builder, id, runId);
            return await runFor(builder, id, runId);
          }
        );

        expect({
          status: run.status,
          code: run.error?.code,
          waitingFor: run.aiProvider,
        }).toStrictEqual({ status: "failed", code, waitingFor: undefined });
      }
    );
  }
);
