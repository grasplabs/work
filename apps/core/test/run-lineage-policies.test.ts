import { runActorOf } from "@grasp-os/shared/audit";
import { runIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { models } from "../src/models.ts";
import { quotaPolicy } from "../src/workflows/quotas.ts";
import { mockIdp } from "./idp.ts";
import {
  allAtOnce,
  inTurn,
  appWith,
  callFor,
  cheapAnswer,
  configuredLimits,
  countOf,
  dearTotal,
  eventsNow,
  generationsOf,
  llmStep,
  onPolicyRead,
  policyGeneration,
  refusalsOf,
  setLedgerGeneration,
  setPolicy,
  statusOf,
  stepCall,
  times,
  withProvider,
} from "./run-lineages.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// A run lineage's provider requests under the operator's quota policy,
// and counted against the run's own lineage, whatever its input names.
// The helpers it shares with the other run lineage files: run-lineages.ts.

const idp = mockIdp();

describe("run lineages", { timeout: 90_000 }, () => {
  it("hold a lineage to the requests its operator's quota policy allows as each is sent, its runs already under way too, never above the platform's", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Lowered" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const rootActor = runActorOf({ runId: root, app, workflow: "reader" });
    const childActor = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
      rootRunId: root,
    });
    const otherLineage = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
    });

    const result = await withProvider(
      undefined,
      times(20, cheapAnswer),
      async (fake) => {
        try {
          const { generation: first } = await quotaPolicy(env);
          const before = await allAtOnce(times(5, rootActor), work);
          // The operator lowers a lineage's requests to 8, while this one
          // is under way with 5 sent.
          const lowering = setPolicy({
            ...configuredLimits,
            lineageModelRequests: 8,
          });
          const lowered = await allAtOnce(times(5, childActor), work);
          const other = await callFor(work, otherLineage);
          // A policy raising it past the platform's is refused whole: the
          // lowered one stays in force.
          setPolicy({ ...configuredLimits, lineageModelRequests: 1000 });
          const raised = await callFor(work, childActor);
          // No longer lowered: the platform's 100 again, and the lineage
          // goes on from the 8 it sent.
          const restoring = setPolicy(configuredLimits);
          const restored = await callFor(work, rootActor);
          return {
            // Each request's receipt, under the policy it was admitted by.
            recorded: await generationsOf(root),
            expected: [
              { generation: first, requests: 5 },
              { generation: lowering, requests: 3 },
              { generation: restoring, requests: 1 },
            ],
            before: countOf(before, "ok"),
            lowered: {
              ok: countOf(lowered, "ok"),
              refused: countOf(lowered, "model.run_limit"),
            },
            other,
            raised,
            restored,
            sent: fake.requests.length,
          };
        } finally {
          setPolicy(configuredLimits);
        }
      }
    );

    const { recorded, expected, ...outcomes } = result;
    expect(outcomes).toStrictEqual({
      before: 5,
      lowered: { ok: 3, refused: 2 },
      other: "ok",
      raised: "model.run_limit",
      restored: "ok",
      sent: 10,
    });
    expect(recorded).toStrictEqual(expected);
  });

  it("hold a provider request's retry to a policy lowered while its call is under way", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Retried" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const actor = runActorOf({ runId: root, app, workflow: "reader" });

    const replies = [
      cheapAnswer,
      cheapAnswer,
      { status: 429, headers: { "retry-after": "1" } },
      cheapAnswer,
    ];
    const result = await withProvider(
      undefined,
      (requests) => {
        // The operator lowers a lineage's requests to the 3 this one has
        // sent, as its third reaches the provider: the provider refuses it
        // for its rate, and the gateway tries again.
        if (requests.length === 3) {
          setPolicy({ ...configuredLimits, lineageModelRequests: 3 });
        }
        return replies[requests.length - 1];
      },
      async (fake) => {
        try {
          const before = await allAtOnce(times(2, actor), work);
          const retried = await callFor(work, actor);
          return {
            before: countOf(before, "ok"),
            retried,
            sent: fake.requests.length,
          };
        } finally {
          setPolicy(configuredLimits);
        }
      }
    );

    expect(result).toStrictEqual({
      before: 2,
      retried: "model.run_limit",
      sent: 3,
    });
  });

  it("hold back a workflow's model call, sending nothing, when its quota policy can't be read or is behind the model ledger's", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Behind" });
    const work = { app, person: builder.userId };
    const unreadableRun = `run-${crypto.randomUUID()}`;
    const behindRun = `run-${crypto.randomUUID()}`;
    const unreadable = runActorOf({
      runId: unreadableRun,
      app,
      workflow: "reader",
    });
    const behind = runActorOf({ runId: behindRun, app, workflow: "reader" });

    const result = await withProvider(
      undefined,
      [cheapAnswer],
      async (fake) => {
        const policyDown = await outcome(
          models({
            ...env,
            DB: onPolicyRead(() => {
              throw new Error("D1_ERROR: the database is unavailable");
            }),
          }).call(stepCall(work, unreadable))
        );
        // The ledger saw a generation core never recorded: core's database
        // restored from before it, say.
        const { generation } = await quotaPolicy(env);
        await setLedgerGeneration(generation + 1_000_000);
        try {
          const ledgerAhead = await callFor(work, behind);
          return {
            policyDown,
            ledgerAhead,
            refused: [
              ...(await refusalsOf(unreadableRun)),
              ...(await refusalsOf(behindRun)),
            ],
            sent: fake.requests.length,
          };
        } finally {
          await setLedgerGeneration();
        }
      }
    );

    expect(result).toStrictEqual({
      policyDown: "model.quota_policy_unavailable",
      ledgerAhead: "model.quota_policy_behind",
      refused: [
        ["model.quota_policy_unavailable", null],
        ["model.quota_policy_behind", null],
      ],
      sent: 0,
    });
  });

  it("read the quota policy again, once, when the model ledger already admitted under a newer one", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Raced" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const actor = runActorOf({ runId: root, app, workflow: "reader" });

    const result = await withProvider(
      undefined,
      [cheapAnswer],
      async (fake) => {
        // Another request already came to the ledger under the operator's
        // next policy, which this call's first read of the policy misses:
        // it is set only as that read reaches the database.
        const next = policyGeneration() + 1;
        await setLedgerGeneration(next);
        const raced = { ...env };
        let changed = false;
        raced.DB = onPolicyRead(() => {
          if (!changed) {
            changed = true;
            raced.QUOTA_LIMITS = {
              generation: setPolicy(configuredLimits),
              limits: configuredLimits,
            };
          }
        });
        try {
          const call = await outcome(models(raced).call(stepCall(work, actor)));
          return {
            call,
            recorded: await generationsOf(root),
            next,
            sent: fake.requests.length,
          };
        } finally {
          await setLedgerGeneration();
        }
      }
    );

    expect(result).toStrictEqual({
      call: "ok",
      recorded: [{ generation: result.next, requests: 1 }],
      next: result.next,
      sent: 1,
    });
  });

  it("count a run's calls against its own lineage, whatever lineage or root its input names", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles("reader", llmStep(), { extract: { total: 1234 } })
    );
    const work = { app, person: builder.userId };
    const victim = runIdSchema.parse(`run-${crypto.randomUUID()}`);
    const victimActor = runActorOf({ runId: victim, app, workflow: "reader" });

    const result = await withProvider(
      undefined,
      [...times(100, cheapAnswer), dearTotal],
      async () => {
        // The victim's lineage used all of its requests.
        const used = await inTurn(times(100, victimActor), work);
        const forged = await builder.api.workflows.start(app, "reader", {
          rootRunId: victim,
          root: victim,
          parent: victim,
          lineage: victim,
          parentRunId: victim,
        });
        await finished(forged.id);
        const events = await eventsNow();
        return {
          used: countOf(used, "ok"),
          forged: await statusOf(builder, forged.id),
          // Its own root: no `rootRunId` at all.
          ownActor: runActorOf({ runId: forged.id, app, workflow: "reader" }),
          actor: events.find(
            ({ action, actor }) =>
              action === "model.call" &&
              actor.type === "workflow" &&
              actor.runId === forged.id
          )?.actor,
          victimAgain: await callFor(work, victimActor),
        };
      }
    );

    expect(result).toMatchObject({
      used: 100,
      forged: "completed",
      victimAgain: "model.run_limit",
    });
    expect(result.actor).toStrictEqual(result.ownActor);
  });
});
