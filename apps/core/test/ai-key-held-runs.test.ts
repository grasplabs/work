import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import { runActorOf } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { anthropic, appWith, eventsOf, llm } from "./model-rules.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { bindModel, workflowFiles } from "./workflow-apps.ts";

// A workflow's AI step when the organization's own AI provider fails its
// calls: it refuses the key (401/403), it isn't answering (5xx, an
// outage), or it is limiting requests (429, a rate or spending limit). A
// step bound to its model never falls back to another, so the run must
// neither fail nor spend its retries on a provider that may come back.
// The ways it can fail come first: the run fails for good on the first
// failure; it waits for good, unseen; it waits on after the key is
// replaced, for someone to restart it; it never notices a provider that
// answers again on its own; it waits past any deadline; it sends a
// request the provider may have taken on again within its attempt. The
// provider behind connect is the outside system (test/model-provider.ts);
// the rest is real, down to the engine's durable waits and wakes.

const idp = mockIdp();

/** What the provider answers while it fails, by what it shows. */
const failures: Readonly<Record<ProviderTrouble, ProviderReply>> = {
  refused: {
    status: 401,
    body: {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
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

/** The step's answer, once calls work. */
const total: ProviderReply = {
  text: '{ "total": 1234 }',
  inputTokens: 10,
  outputTokens: 5,
};

/**
 * An App with one AI step, bound to Anthropic, started once; the provider
 * failing as `shows` says until `provider.working`, counting what it got.
 */
const heldRun = async (
  provider: { working: boolean; asked: number },
  shows: ProviderTrouble
) => {
  const builder = await signedInApi(idp, "builder");
  const app = await appWith(
    builder,
    workflowFiles("reader", llm(""), { extract: { total: 1234 } })
  );
  const fake = await answeringProvider(
    () => {
      provider.asked += 1;
      return provider.working ? total : failures[shows];
    },
    { models: [anthropic] }
  );
  await bindModel(app, "reader", anthropic);
  const run = await builder.api.workflows.start(app, "reader");
  return { builder, app, fake, run };
};

/** Once the run reads as waiting for its AI provider: what it says it waits for. */
const waitingFor = async (
  builder: Awaited<ReturnType<typeof signedInApi>>,
  runId: string
) => {
  await vi.waitFor(
    async () => {
      const { status, aiProvider } = await builder.api.workflows.status(runId);
      expect({ status, since: typeof aiProvider?.since }).toStrictEqual({
        status: "queued",
        since: "string",
      });
    },
    { timeout: 20_000, interval: 200 }
  );
  const { status, aiProvider } = await builder.api.workflows.status(runId);
  return {
    status,
    provider: aiProvider?.provider,
    trouble: aiProvider?.trouble,
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
  "a workflow's AI step when the organization's AI provider fails its calls",
  { timeout: 90_000 },
  () => {
    afterEach(endLiveRuns);

    it("holds the run while the provider refuses the key, says so, and completes once an admin replaces it, with nobody restarting it", async () => {
      // Timed tries a minute apart: only the replacement's wake can resume
      // the run within the test.
      const result = await withEnv(
        "WORKFLOW_OFF_WAIT_MS",
        "59000",
        async () => {
          const provider = { working: false, asked: 0 };
          const { builder, app, fake, run } = await heldRun(
            provider,
            "refused"
          );
          const held = await waitingFor(builder, run.id);
          const admin = await signedInApi(idp, "admin");
          const failing = await admin.api.aiProviders.list();
          provider.working = true;
          // The admin replaces the key (the provider's fake knows it by its
          // value, so it stays the same).
          await admin.api.aiProviders.add({
            provider: "anthropic",
            key: fake.key,
          });
          await finished(run.id, 30_000);
          const replaced = await admin.api.aiProviders.list();
          const events = await eventsOf(
            runActorOf({ runId: run.id, app, workflow: "reader" })
          );
          return {
            held,
            failing: failing.providers[0]?.status?.failingClass,
            replaced: replaced.providers[0]?.status?.failingSince,
            done: await builder.api.workflows.status(run.id),
            waited: events
              .filter(({ action }) => action === "workflow.run.waiting")
              .map(({ detail }) => detail.trouble),
          };
        }
      );

      expect(result).toMatchObject({
        held: { status: "queued", provider: "anthropic", trouble: "refused" },
        failing: "refused",
        replaced: null,
        done: { status: "completed", output: { total: 1234 } },
        // Recorded once, however many times it tried.
        waited: ["refused"],
      });
      expect(result.done).not.toHaveProperty("aiProvider");
    });

    it.each(["not_answering", "limiting"] as const)(
      "holds the run while the provider shows %s, and completes by itself once it answers again, each try a request of its own",
      async (shows) => {
        const provider = { working: false, asked: 0 };
        const { builder, run } = await heldRun(provider, shows);
        const held = await waitingFor(builder, run.id);
        // Requests sent while it was held: one per try, never sent again
        // within a try.
        await vi.waitFor(
          () => {
            expect(provider.asked).toBeGreaterThanOrEqual(2);
          },
          { timeout: 20_000, interval: 100 }
        );
        const admin = await signedInApi(idp, "admin");
        const { providers } = await admin.api.aiProviders.list();
        // The outage ends, or the limit lifts: nobody touches Grasp.
        provider.working = true;
        await finished(run.id, 30_000);

        expect({
          held,
          shows: providers[0]?.status?.failingClass,
          done: await builder.api.workflows.status(run.id),
        }).toMatchObject({
          held: { status: "queued", provider: "anthropic", trouble: shows },
          shows,
          done: { status: "completed", output: { total: 1234 } },
        });
      }
    );

    it.each([
      ["refused", "model.provider_key_failed"],
      ["not_answering", "model.provider_unavailable"],
      ["limiting", "model.rate_limited"],
    ] as const)(
      "fails the run once it waited as long as a step may, with what the provider showed (%s)",
      async (shows, code) => {
        const run = await withEnv(
          "WORKFLOW_AI_KEY_HOLD_MS",
          "1500",
          async () => {
            const held = await heldRun({ working: false, asked: 0 }, shows);
            await finished(held.run.id, 30_000);
            return await held.builder.api.workflows.status(held.run.id);
          }
        );

        expect(run).toMatchObject({
          status: "failed",
          failure: { error: { code } },
        });
        expect(run).not.toHaveProperty("aiProvider");
      }
    );
  }
);
