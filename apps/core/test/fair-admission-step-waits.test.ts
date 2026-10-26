import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { requestGranted } from "./apps.ts";
import {
  policyWith,
  withShares,
  idle,
  idleRun,
  admit,
  working,
  loadWaitsOf,
  failedWith,
  placesOf,
  settled,
  eventually2,
  eventually,
} from "./fair-admission.ts";
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

// How long a step may wait for a share (`workflowQueuedStepMs`), as the
// operator sets it, and what counts as its wait.
// The helpers and the rest of fair admission's tests: fair-admission.ts
// and the fair-admission*.test.ts files beside it.

const idp = mockIdp();

describe("fair workflow admission", { timeout: 120_000 }, () => {
  it("fail a step that waited for a share as long as a step may wait", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...workflowFiles("work", `${working("work", 10)}\n  return 1;`, {
        work: 1,
      }),
    });
    const holderRun = await builder.api.workflows.start(app, "noop");
    await finished(holderRun.id);
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const failed = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 8000 },
      async () => {
        await admit(holder, "holder");
        const startedAt = Date.now();
        const run = await builder.api.workflows.start(app, "work");
        // Its second round: ten seconds of backoff, three left of its eight.
        await scheduler.wait(6500);
        const summary = await builder.api.screens
          .frame(app, "")
          .summary(run.id);
        await finished(run.id);
        return {
          code: await failedWith(run.id),
          // When it said it asks again, from its start: never past its
          // eight seconds, which began as it first waited.
          asksAgainBy: (summary.queued?.retryAt ?? 0) - startedAt,
        };
      }
    );

    expect(failed.code).toBe("workflow.queue_timeout");
    expect(failed.asksAgainBy).toBeGreaterThan(0);
    expect(failed.asksAgainBy).toBeLessThanOrEqual(9500);
  });

  it("stop a step that waited as long as a step may, though a share comes free before it asks again, and run none of its code", async () => {
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
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 8000 },
      async () => {
        const held = await admit(holder, "holder");
        const run = await builder.api.workflows.start(app, "counted");
        // Its share comes free at twelve seconds, after its eight are up.
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

  it("count a step's wait for a share only while it waits for one, starting over once it was admitted and held for its person", async () => {
    const admin = await signedInApi(idp, "admin");
    const mail = await mailConnection([]);
    // A pause first, so the send is the step that waits for a share.
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
    const holder = {
      run: holderRun.id,
      root: holderRun.id,
      subject: admin.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 10_000 },
      async () => {
        const run = await admin.api.workflows.start(app, "mailer");
        // The share is taken as the run pauses: its send waits for it.
        await sleeping(run.id, "pause");
        const first = await admit(holder, "first holder");
        await eventually(async () => {
          await expect(placesOf(run.id)).resolves.toBe(1);
        });
        // It comes free: the send runs, and waits for the person.
        await settled(first);
        const pending = await eventually2(async () => {
          const listed = await admin.api.pendingActions.list();
          const held = listed.find(({ action }) => action === "mail.send");
          expect(held).toBeDefined();
          return held;
        });
        // The person takes longer than a step may wait for a share: none
        // of it is a wait for one.
        await scheduler.wait(12_000);
        // The share is taken again before they confirm: the send waits for
        // it once more, its ten seconds starting over.
        await admit(holder, "second holder");
        if (pending !== undefined) {
          await admin.api.pendingActions.confirm(pending.id, pending.inputHash);
        }
        // Once its next check saw the confirmation, it queues again.
        await eventually(async () => {
          await expect(placesOf(run.id)).resolves.toBe(1);
        });
        const queuedAgainAt = Date.now();
        await finished(run.id);
        return {
          failed: await failedWith(run.id),
          // Its whole ten seconds, not the five its first wait left.
          waitedAfresh: Date.now() - queuedAgainAt >= 8000,
        };
      }
    );

    expect(result).toStrictEqual({
      failed: "workflow.queue_timeout",
      waitedAfresh: true,
    });
  });

  it("stop a step that waited longer than the cap the operator lowered meanwhile, before any of its code runs", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...idle,
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
    const holderRun = await idleRun(builder, app);
    const holder = {
      run: holderRun,
      root: holderRun,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares({ workflowClientAttempts: 2 }, async () => {
      const held = await admit(holder, "holder");
      const run = await builder.api.workflows.start(app, "counted");
      // Ten seconds into its wait, the operator lowers the cap to eight,
      // and its share comes free before it asks again.
      await scheduler.wait(10_000);
      policyWith({ workflowClientAttempts: 2, workflowQueuedStepMs: 8000 });
      await settled(held);
      await finished(run.id);
      return {
        failed: await failedWith(run.id),
        hits: await hitsOf(builder, app, "work"),
      };
    });

    expect(result).toStrictEqual({ failed: "workflow.queue_timeout", hits: 0 });
  });

  it("keep a step waiting past the cap its last refusal named, once the operator raised it as the step slept", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("noop", "  return 1;"),
      ...idle,
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
    const holderRun = await idleRun(builder, app);
    const holder = {
      run: holderRun,
      root: holderRun,
      subject: builder.userId,
      resource: app,
    };

    const result = await withShares(
      { workflowClientAttempts: 2, workflowQueuedStepMs: 8000 },
      async () => {
        const held = await admit(holder, "holder");
        const run = await builder.api.workflows.start(app, "counted");
        // Its second round sleeps until its eight seconds are up, as its
        // refusal said; the operator raises the cap as it sleeps, and its
        // share comes free.
        await eventually(async () => {
          await expect(loadWaitsOf(run.id)).resolves.toHaveLength(2);
        });
        policyWith({ workflowClientAttempts: 2 });
        await settled(held);
        await finished(run.id);
        return {
          failed: (await failedWith(run.id)) ?? null,
          status: await liveStatus(run.id),
          hits: await hitsOf(builder, app, "work"),
        };
      }
    );

    expect(result).toStrictEqual({
      failed: null,
      status: "complete",
      hits: 1,
    });
  });
});
