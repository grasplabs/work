import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { admitAttempt } from "../src/workflows/quotas.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { finished, liveStatus, sleeping } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import {
  appWith,
  hitCall,
  hitsOf,
  invoiceMail,
  workflowFiles,
} from "./workflow-apps.ts";
import {
  admitted,
  withShares,
  ownerOf,
  anotherRun,
  testGeneration,
  attemptOf,
  admit,
  shown,
  working,
  admitExactly,
  aged,
  failedWith,
  loadWaitsOf,
  settled,
  eventually,
} from "./workflow-slots.ts";

// The limit on workflow attempts running at once (admission.ts): in the
// whole deployment, and of one App, each a quota limit a test lowers
// (`TEST_QUOTA_LIMITS`) to reach it. Runs, the engine, the dispatcher and
// core's database are real; attempts are admitted as a run's host admits
// them (quotas.ts, `admitAttempt`).

const idp = mockIdp();

describe("workflow attempts running at once", { timeout: 120_000 }, () => {
  it("admit no more at once than the deployment's or an App's limit, however many race, the same attempt once, and the next once one settles", async () => {
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
        // Six of one App's attempts at once: two fit its limit.
        const racing = await Promise.all(
          Array.from(
            { length: 6 },
            async (_, index) => await admit(hot, `hot-${index}`)
          )
        );
        // The first admitted, admitted again: it holds one slot.
        const again = racing.findIndex((answer) => "admitted" in answer);
        const twice = await admit(hot, `hot-${again}`);
        // Another App still has room; the deployment's last slot goes to
        // it, and a third App's attempt finds none.
        const otherApp = await admit(other, "other");
        const lastApp = await admit(late, "late");
        // One of the hot App's attempts settles: its slot comes back.
        const held = racing[again];
        if (held !== undefined && "admitted" in held) {
          await held.admitted.settle();
        }
        const afterSettle = await admit(late, "late");
        return {
          racing: racing.map(shown).toSorted(),
          twice: shown(twice),
          otherApp: shown(otherApp),
          lastApp: shown(lastApp),
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
      otherApp: "ok",
      lastApp: "workflow.queued",
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

  it("run another App's workflow while a busy App's runs wait for a slot, and run them all once slots come free", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const hot = await appWith(
      first,
      workflowFiles("slow", `${working("work", 1500)}\n  return 1;`, {
        work: 1,
      })
    );
    const other = await appWith(
      second,
      workflowFiles("quick", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      })
    );

    const result = await withShares(
      { workflowClientAttempts: 3, workflowAppAttempts: 2 },
      async () => {
        const hotRuns = await Promise.all(
          Array.from(
            { length: 3 },
            async () => await first.api.workflows.start(hot, "slow")
          )
        );
        const quick = await second.api.workflows.start(other, "quick");
        await finished(quick.id);
        const hotWhenQuickDone = await Promise.all(
          hotRuns.map(async ({ id }) => await liveStatus(id))
        );
        // The hot App's last run waits a round or two, five and ten
        // seconds long (admission.ts, `askAgainMs`), before a slot is its.
        await eventually(async () => {
          const statuses = await Promise.all(
            hotRuns.map(async ({ id }) => await liveStatus(id))
          );
          expect(statuses).toStrictEqual(["complete", "complete", "complete"]);
        }, 60_000);
        return {
          quick: await liveStatus(quick.id),
          hotStillRunning: hotWhenQuickDone.some(
            (status) => status !== "complete"
          ),
        };
      }
    );

    expect(result).toStrictEqual({ quick: "complete", hotStillRunning: true });
  });

  it("stop a step that waited for a slot as long as a step may, though one comes free before it asks again, and run none of its code", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles(
        "counted",
        `  await step.do("work", { description: "Work" }, async () => {
    await ${hitCall(`"work"`)};
    return 1;
  });
  return 1;`,
        { work: 1 }
      ),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = { run: holderRun.id, root: holderRun.id, resource: app };

    const result = await withShares(
      {
        workflowClientAttempts: 2,
        workflowAppAttempts: 1,
        workflowQueuedStepMs: 8000,
      },
      async () => {
        const held = await admit(holder, "holder");
        const run = await builder.api.workflows.start(app, "counted");
        // Its slot comes free at twelve seconds, after its eight are up.
        await scheduler.wait(12_000);
        if ("admitted" in held) {
          await held.admitted.settle();
        }
        await finished(run.id);
        return {
          failed: await failedWith(run.id),
          hits: await hitsOf(builder, app, "work"),
        };
      }
    );

    expect(result).toStrictEqual({ failed: "workflow.queue_timeout", hits: 0 });
  });

  it("count a step's wait for a slot only while it waits for one, starting over once it was admitted and held for its person", async () => {
    const admin = await signedInApi(idp, "admin");
    const mail = await mailConnection([]);
    // A pause first, so the send is the step that waits for a slot.
    const app = await appWith(admin, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles(
        "mailer",
        `  await step.sleep("pause", { description: "Wait", duration: "3 seconds" });
  return await step.do("send", { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, retries: { limit: 0 } }, async ({ idempotencyKey, input: mail }) => JSON.parse(((await env.MAIL.call("mail.send", mail, { idempotencyKey })) as { output: string }).output));`,
        { send: { messageId: "mocked" } }
      ),
    });
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    await appHost(env, appIdSchema.parse(app)).restrict();
    const holderRun = await admin.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = { run: holderRun.id, root: holderRun.id, resource: app };

    const result = await withShares(
      {
        workflowClientAttempts: 2,
        workflowAppAttempts: 1,
        workflowQueuedStepMs: 10_000,
      },
      async () => {
        const run = await admin.api.workflows.start(app, "mailer");
        // The slot is taken as the run pauses: its send waits for it.
        await sleeping(run.id, "pause");
        const first = await admit(holder, "first holder");
        await eventually(async () => {
          await expect(loadWaitsOf(run.id)).resolves.not.toHaveLength(0);
        });
        // It comes free: the send runs, and waits for the person.
        await settled(first);
        const pending = await vi.waitFor(
          async () => {
            const listed = await admin.api.pendingActions.list();
            const held = listed.find(({ action }) => action === "mail.send");
            expect(held).toBeDefined();
            return held;
          },
          { timeout: 20_000, interval: 200 }
        );
        // The person takes longer than a step may wait for a slot: none
        // of it is a wait for one.
        await scheduler.wait(12_000);
        // The slot is taken again before they confirm: the send waits for
        // it once more, its ten seconds starting over.
        await admit(holder, "second holder");
        const roundsBefore = await loadWaitsOf(run.id);
        if (pending !== undefined) {
          await admin.api.pendingActions.confirm(pending.id, pending.inputHash);
        }
        // Once its next check saw the confirmation, it waits again.
        await eventually(async () => {
          const rounds = await loadWaitsOf(run.id);
          expect(rounds.length).toBeGreaterThan(roundsBefore.length);
        });
        const waitingAgainAt = Date.now();
        await finished(run.id);
        return {
          failed: await failedWith(run.id),
          // Its whole ten seconds, not the five its first wait left.
          waitedAfresh: Date.now() - waitingAgainAt >= 8000,
        };
      }
    );

    expect(result).toStrictEqual({
      failed: "workflow.queue_timeout",
      waitedAfresh: true,
    });
  });
});
