import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { admitAttempt } from "../src/workflows/quotas.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import {
  admitted,
  withShares,
  ownerOf,
  anotherRun,
  testGeneration,
  attemptOf,
  admit,
  shown,
  admitExactly,
  aged,
} from "./workflow-slots.ts";

// The limit on workflow attempts running at once (admission.ts): in the
// whole deployment, and of one workflow, each a quota limit a test lowers
// (`TEST_QUOTA_LIMITS`) to reach it. Runs, the engine, the dispatcher and
// core's database are real; attempts are admitted as a run's host admits
// them (quotas.ts, `admitAttempt`).

const idp = mockIdp();

describe("workflow attempts running at once", { timeout: 120_000 }, () => {
  it("admit no more at once than the deployment's or a workflow's limit, however many race, the same attempt once, and the next once one settles", async () => {
    const [first, second, third] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const hot = await ownerOf(first);
    const other = await ownerOf(second);
    const late = await ownerOf(third);

    const result = await withShares(
      { workflowClientAttempts: 3, workflowAppAttempts: 2 },
      async () => {
        // Six of one workflow's attempts at once: two fit its limit.
        const racing = await Promise.all(
          Array.from(
            { length: 6 },
            async (_, index) => await admit(hot, `hot-${index}`)
          )
        );
        // The first admitted, admitted again: it holds one slot.
        const again = racing.findIndex((answer) => "admitted" in answer);
        const twice = await admit(hot, `hot-${again}`);
        // Another workflow still has room; the deployment's last slot goes to
        // it, and a third workflow's attempt finds none.
        const otherWorkflow = await admit(other, "other");
        const lastWorkflow = await admit(late, "late");
        // One of the hot workflow's attempts settles: its slot comes back.
        const held = racing[again];
        if (held !== undefined && "admitted" in held) {
          await held.admitted.settle();
        }
        const afterSettle = await admit(late, "late");
        return {
          racing: racing.map(shown).toSorted(),
          twice: shown(twice),
          otherWorkflow: shown(otherWorkflow),
          lastWorkflow: shown(lastWorkflow),
          afterSettle: shown(afterSettle),
        };
      }
    );

    expect(result).toStrictEqual({
      racing: [
        "ok",
        "ok",
        "workflow.queued",
        "workflow.queued",
        "workflow.queued",
        "workflow.queued",
      ],
      twice: "ok",
      otherWorkflow: "ok",
      lastWorkflow: "workflow.queued",
      afterSettle: "ok",
    });
  });

  it("give back an attempt's slot once its deadline passes, though it never settled, and take none for an admission whose write never landed", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        // Admitted, then its activation dies: it never settles.
        await admit(owner, "dies", 1500);
        const whileHeld = shown(await admit(owner, "next"));
        await scheduler.wait(1600);
        // An admission that dies before its write lands takes nothing.
        const database = env.DB;
        env.DB = new Proxy(database, {
          get: (target, property) => {
            if (property === "batch") {
              return async () => {
                await Promise.resolve();
                throw new Error("Core stopped mid-admission");
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
        let crashed: unknown;
        try {
          await admitAttempt(env, owner, attemptOf("crashed"));
        } catch (error) {
          crashed = error;
        } finally {
          env.DB = database;
        }
        const afterDeadline = shown(await admit(owner, "next"));
        return { whileHeld, crashed: crashed instanceof Error, afterDeadline };
      }
    );

    expect(result).toStrictEqual({
      whileHeld: "workflow.queued",
      crashed: true,
      afterDeadline: "ok",
    });
  });

  it("stop counting a slot an attempt's wall time after its admission, whatever its deadline, and let a new activation's attempt in past the one it replaced", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);
    const otherLineage = await anotherRun(builder, owner);
    const replaced = await anotherRun(builder, owner);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        // Its deadline ten minutes on; its activation dies at once.
        await admit(owner, "dies", 10 * 60_000);
        const whileHeld = shown(await admit(otherLineage, "next"));
        await aged(
          "run_lineage_attempts",
          "admitted_at",
          "step_key = 'key-dies'",
          61_000
        );
        const afterWallTime = shown(await admit(otherLineage, "next"));
        await Promise.all(
          admitted.splice(0).map(async (admission) => {
            await admission.settle();
          })
        );
        // The same step's attempt under two activations: the engine fenced
        // the first as it gave the step to the second.
        const step = attemptOf("retried", 10 * 60_000);
        const firstTry = await admitExactly(replaced, step);
        const secondTry = await admitExactly(replaced, {
          ...step,
          generation: testGeneration + 1,
        });
        return { whileHeld, afterWallTime, firstTry, secondTry };
      }
    );

    expect(result).toStrictEqual({
      whileHeld: "workflow.queued",
      afterWallTime: "ok",
      firstTry: "ok",
      secondTry: "ok",
    });
  });
});
