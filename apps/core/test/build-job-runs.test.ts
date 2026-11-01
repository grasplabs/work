import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { BuildJobRecords, jobRecordsKept } from "../src/build-job-records.ts";
import { personOf } from "../src/connections.ts";
import { workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  pausedReply,
  configureObject,
  says,
  transcript,
} from "./agent-chat.ts";
import { published, release, requestGranted } from "./apps.ts";
import type { jobRowSchema } from "./build-jobs.ts";
import {
  appName,
  desk,
  restyled,
  errorCode,
  returned,
  submitProposal,
  holdFiles,
  envOf,
  storedTrees,
  writtenMeanwhile,
  screenBuilds,
  submittedJob,
  endedJob,
  runRecords,
  createdApp,
  jobEvents,
  buildJobsOf,
} from "./build-jobs.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { fakeProvider } from "./model-provider.ts";
import { runInstance } from "./runs.ts";
import { signedIn, signedInApi, staffPerson, whoami } from "./sign-in.ts";

// A build a chat's code hands to a durable job (`env.build.submit`): it
// goes on after the code run that submitted it ends, as a workflow of
// core's own, and how it ended reaches the turn that submitted it. These
// tests start from how that can go wrong: the result reaches a turn that
// has ended, or a later one; a permission revoked while the job runs
// doesn't stop what it does next; and a restart of the job makes its
// commit twice.

// Here: how a job goes on, and what reaches which turn; a job's commit
// is build-job-commits.test.ts's, its place in the client's builds
// build-job-queue.test.ts's.

const idp = mockIdp();
const { setUp } = buildJobsOf(idp);

/**
 * A chat of a Grasp staff member's (GRA-1088) whose turn writes a draft of
 * an admin's App and submits its check, its agent allowed to build Apps,
 * and the turn sent as core sends a staff member's: marked.
 */
const staffCheck = async () => {
  const admin = await signedInApi(idp, "admin");
  const { id: app } = await admin.api.apps.create({ name: "Staffed" });
  await published(app);
  // Released, so the Apps collection is there to grant.
  await release(admin, app, { "AGENTS.md": "# Staffed\n" });
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { userId: staffId } = await whoami(session);
  const chat = await chatOf(
    staffId,
    codeStep(`export default async (self, env) => {
      await env.build.write(${JSON.stringify(app)}, ${JSON.stringify({ "screens/desk.tsx": desk })});
      return await env.build.submit(${JSON.stringify(app)}, { kind: "check" });
    };`),
    says("Submitted.")
  );
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "collection", collectionId: "apps" },
    actions: ["read", "write"],
    binding: "APP_LIBRARY",
  });
  const send = async () => {
    await chat.stub.send(
      chat.chat.id,
      staffId,
      { text: "Check the desk", model },
      true
    );
  };
  return { chat, staffId, send };
};

/** Ends every staff session of `userId`, as their sign-out or expiry would. */
const staffSessionsEnd = async (userId: string): Promise<void> => {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND staff = 1")
    .bind(userId)
    .run();
};

/** Code that finds the App the agent created, by its name, as `app`. */
const findApp = `const [app] = (await env.apps.list()).filter(({ name }) => name === ${JSON.stringify(appName)});`;

describe("build jobs", { timeout: 180_000 }, () => {
  it("finishes a proposal after the run that submitted it ended, tells that turn how it ended, and no later turn", async () => {
    const waiting = pausedReply(says("I'll say once the build is done."), 3);
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      waiting.reply,
      says("The invoice desk is proposed for review."),
    ]);

    const checking = holdFiles(screenBuilds);
    let job: z.infer<typeof jobRowSchema>;
    let run: { ended_at: number | null } | undefined;
    const answering = chat.ask("Build an invoice desk for invoices@");
    try {
      job = await submittedJob(chat.stub, chat.chat.id);
      await checking.reached();
      // The run that submitted it has ended; the job goes on without it.
      [run] = await vi.waitFor(
        async () => {
          const records = await runRecords(chat.stub, chat.chat.id);
          expect(records.map(({ status }) => status)).toStrictEqual([
            "completed",
          ]);
          return records;
        },
        { timeout: 30_000, interval: 50 }
      );
      const held = await chat.stub.buildJob(chat.chat.id, job.id);
      expect(held?.status).toBe("running");
    } finally {
      checking.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect({
      ...ended,
      afterItsRun: (ended.endedAt?.getTime() ?? 0) > (run?.ended_at ?? 0),
    }).toMatchObject({ status: "completed", version: 1, afterItsRun: true });

    // The turn is still answering: once its answer is in, it reads how
    // the job ended, before it answers again.
    waiting.release();
    const answer = await answering;
    const messages = await transcript(chat.stub, chat.chat.id);
    const { app, versions } = await createdApp(builder);
    const lastRequest = JSON.stringify(chat.provider.requests.at(-1)?.body);
    // A later turn of the chat.
    const later = await fakeProvider(says("Anything else?"));
    await configureObject(chat.stub);
    await chat.ask("Thanks.");
    expect({
      answer,
      // The model was sent the notice with its last request of the turn,
      // naming the run that submitted it.
      sent: lastRequest.includes(`Build job ${job.id}`),
      byItsRun: lastRequest.includes("submitted by code run"),
      // It isn't stored with the chat, so no later request carries it.
      stored: await jobEvents(chat.stub, chat.chat.id, job.id),
      // (Its ID is still there, in what the code that submitted it returned.)
      laterSent: JSON.stringify(later.requests[0]?.body).includes(
        `Build job ${job.id}`
      ),
      last: messages.at(-1)?.role,
      // It proposed the draft once, as the chat's agent, for review.
      app: { pending: app.pendingVersion, current: app.currentVersion },
      versions: versions.map(({ version, proposedBy }) => ({
        version,
        chat: proposedBy?.chatId,
        job: proposedBy?.jobId,
      })),
    }).toMatchObject({
      answer: {
        outcome: "answered",
        answer: "The invoice desk is proposed for review.",
      },
      sent: true,
      byItsRun: true,
      stored: [],
      laterSent: false,
      last: "assistant",
      app: { pending: 1, current: null },
      versions: [{ version: 1, chat: chat.chat.id, job: job.id }],
    });
  });

  it("tells neither the turn that submitted a job, once it ended, nor a later turn how it ended", async () => {
    const later = pausedReply(says("Something else, meanwhile."), 3);
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted: it goes on after this answer."),
      later.reply,
    ]);

    const checking = holdFiles(screenBuilds);
    let answering: ReturnType<typeof chat.ask>;
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Build an invoice desk for invoices@");
      job = await submittedJob(chat.stub, chat.chat.id);
      await checking.reached();
      // Its turn has ended; the job still runs.
      expect(job.status).toBe("running");
      // A later turn runs while the job ends.
      answering = chat.ask("Anything else?");
      await vi.waitFor(
        () => {
          expect(chat.provider.requests).toHaveLength(3);
        },
        { timeout: 30_000, interval: 50 }
      );
    } finally {
      checking.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect(ended).toMatchObject({ status: "completed", version: 1 });
    later.release();
    await expect(answering).resolves.toMatchObject({ outcome: "answered" });

    // Neither turn was told: no message names it, and the later turn made
    // one model request, its answer, and no other.
    await expect(
      jobEvents(chat.stub, chat.chat.id, job.id)
    ).resolves.toStrictEqual([]);
    expect(chat.provider.requests).toHaveLength(3);
    // What it came to is on its record, for the agent to read.
    const { versions } = await createdApp(builder);
    expect(versions).toHaveLength(1);
  });

  it("ends a job when the person stops the turn that submitted it, and commits nothing", async () => {
    const waiting = pausedReply(says("I'll say once the build is done."), 3);
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      waiting.reply,
    ]);

    const checking = holdFiles(screenBuilds);
    const answering = chat.ask("Build an invoice desk for invoices@");
    let job: z.infer<typeof jobRowSchema>;
    try {
      job = await submittedJob(chat.stub, chat.chat.id);
      await checking.reached();
      await expect(
        chat.stub.cancel(chat.chat.id, chat.personId)
      ).resolves.toBeTruthy();
    } finally {
      checking.restore();
      waiting.release();
    }
    await expect(answering).resolves.toMatchObject({ outcome: "cancelled" });

    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    const { versions } = await createdApp(builder);
    expect({ ended, versions }).toMatchObject({
      ended: { status: "cancelled", version: null, result: null },
      versions: [],
    });
  });

  it("counts job checks with the repair loop, and refuses a fifth once four failed in a row", async () => {
    const waitForJob = (
      submit: string
    ) => `export default async (self, env) => {
      ${findApp}
      const { job } = await env.build.submit(app.id, ${submit});
      for (let poll = 0; poll < 80; poll += 1) {
        const view = await env.build.job(job);
        if (view.status !== "running") {
          return { status: view.status, passed: view.result.passed, failedInARow: view.result.failedInARow };
        }
        await scheduler.wait(300);
      }
      return "still running";
    };`;
    const failingCheck = codeStep(waitForJob('{ kind: "check" }'));
    const { chat } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled })});
        return app.id;
      };`),
      failingCheck,
      codeStep(waitForJob('{ kind: "check" }')),
      codeStep(waitForJob('{ kind: "check" }')),
      codeStep(waitForJob('{ kind: "check" }')),
      codeStep(`export default async (self, env) => {
        ${findApp}
        const tried = async (call) => { try { await call(); return "done"; } catch (error) { return error.message; } };
        return {
          submit: await tried(() => env.build.submit(app.id, { kind: "check" })),
          propose: await tried(() => env.build.submit(app.id, { kind: "propose", message: "A desk" })),
          check: await tried(() => env.build.check(app.id)),
        };
      };`),
      says("The desk still fails its checks: the button is restyled."),
    ]);

    await chat.ask("Build an invoice desk for invoices@");

    const results = await codeResults(chat.stub, chat.chat.id);
    const exhausted = appErrors.create("app.checks_exhausted").message;
    expect(results.slice(1).map(({ text }) => returned(text))).toStrictEqual([
      ...[1, 2, 3, 4].map((failedInARow) => ({
        status: "completed",
        passed: false,
        failedInARow,
      })),
      { submit: exhausted, propose: exhausted, check: exhausted },
    ]);
  });

  it("holds a chat to three running jobs, submitted at once too, and frees the place of one whose instance ended", async () => {
    // The model takes its time over its next step, which submits a fifth.
    const waiting = pausedReply(
      {
        ...codeStep(`export default async (self, env) => {
          ${findApp}
          try { return (await env.build.submit(app.id, { kind: "check" })).status; } catch (error) { return error.message; }
        };`),
        text: "Submitting another.",
      },
      3
    );
    const { chat } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": desk })});
        return await Promise.all([1, 2, 3, 4].map(() =>
          env.build.submit(app.id, { kind: "check" }).then(({ job }) => job, (error) => error.message)
        ));
      };`),
      waiting.reply,
      says("Checking."),
    ]);
    const exhausted = agentErrors.create("agent.jobs_exhausted").message;
    const checking = holdFiles(screenBuilds);
    let submitted: unknown;
    let fifth: unknown;
    let ended: Awaited<ReturnType<typeof endedJob>>;
    try {
      const answering = chat.ask("Build an invoice desk for invoices@");
      await vi.waitFor(
        async () => {
          const [result] = await codeResults(chat.stub, chat.chat.id);
          expect(result).toBeDefined();
          submitted = returned(result?.text);
        },
        { timeout: 60_000, interval: 50 }
      );
      // Whichever submission lost the race is refused, the first as well
      // as the last: one that started is any other.
      const started = z
        .array(z.string())
        .parse(submitted)
        .find((job) => job !== exhausted);
      // Its instance ends behind the record's back: the record still runs.
      const instance = runInstance(started ?? "");
      await instance.terminate();
      waiting.release();
      await answering;
      const results = await codeResults(chat.stub, chat.chat.id);
      fifth = results[1]?.text;
      ended = await endedJob(chat.stub, chat.chat.id, started ?? "");
    } finally {
      checking.restore();
    }
    const all = z.array(z.string()).parse(submitted);
    expect({
      refused: all.filter((job) => job === exhausted).length,
      started: all.filter((job) => job !== exhausted).length,
      fifth,
      ended: { status: ended.status, code: errorCode(ended.error) },
    }).toStrictEqual({
      refused: 1,
      started: 3,
      fifth: "Returned:\nrunning",
      ended: { status: "failed", code: "internal.unexpected" },
    });
  });

  it("hands on nothing of a job whose person stopped building its App while it ran", async () => {
    const other = await signedInApi(idp, "builder");
    const { id: shared } = await other.api.apps.create({ name: "Shared" });
    await published(shared);
    const { builder, chat } = await setUp([
      codeStep(`export default async (self, env) => {
        await env.build.write(${JSON.stringify(shared)}, ${JSON.stringify({ "screens/desk.tsx": desk })});
        return await env.build.submit(${JSON.stringify(shared)}, { kind: "check" });
      };`),
      says("Submitted."),
    ]);
    await other.api.apps.members.add(shared, {
      type: "person",
      id: builder.userId,
      role: "builder",
    });
    const checking = holdFiles(screenBuilds);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Check the shared App");
      job = await submittedJob(chat.stub, chat.chat.id);
      await checking.reached();
      // They use it from now on, but no longer build it.
      await other.api.apps.members.add(shared, {
        type: "person",
        id: builder.userId,
        role: "user",
      });
    } finally {
      checking.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect({
      status: ended.status,
      result: ended.result,
      code: errorCode(ended.error),
    }).toStrictEqual({
      status: "failed",
      result: null,
      code: "role.forbidden",
    });
  });

  it("runs a job a Grasp staff member's turn submitted as them", async () => {
    const { chat, send } = await staffCheck();
    await send();
    const job = await submittedJob(chat.stub, chat.chat.id);
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);

    expect({
      status: ended.status,
      code: errorCode(ended.error),
    }).toStrictEqual({ status: "completed", code: null });
  });

  it("fails a staff member's job once their staff session has ended", async () => {
    const { chat, staffId, send } = await staffCheck();
    const checking = holdFiles(screenBuilds);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await send();
      job = await submittedJob(chat.stub, chat.chat.id);
      // After its only step was admitted: its last step finds it.
      await checking.reached();
      await staffSessionsEnd(staffId);
    } finally {
      checking.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);

    expect({
      status: ended.status,
      result: ended.result,
      code: errorCode(ended.error),
    }).toStrictEqual({
      status: "failed",
      result: null,
      code: "permission.person_inactive",
    });
  });

  it("keeps a chat's latest hundred ended job records, and every running one", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);
    const job = (id: string) => ({
      id,
      chatId,
      turnId: "turn",
      runId: "run",
      appId: "app",
      kind: "check" as const,
      message: null,
      revision: 1,
      grantedAt: 0,
    });
    const ended = Array.from(
      { length: jobRecordsKept + 5 },
      (_, at) => `ended-${String(at).padStart(3, "0")}`
    );
    const kept = await runInDurableObject(chat.stub, (_instance, state) => {
      // What the chat's object keeps its jobs in, as it keeps them.
      const records = new BuildJobRecords(drizzle(state.storage));
      // The oldest, still running as the others come and go.
      records.open(job("running"));
      for (const id of ended) {
        records.open(job(id));
        records.end(chatId, id, { status: "cancelled" });
      }
      return state.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM chat_build_jobs WHERE chat_id = ? ORDER BY id",
          chatId
        )
        .toArray()
        .map(({ id }) => id);
    });
    expect(kept).toStrictEqual(
      [...ended.slice(-jobRecordsKept), "running"].toSorted()
    );
  });

  it("refuses to read a job to a person who no longer builds its App, and keeps its record", async () => {
    const other = await signedInApi(idp, "builder");
    const { id: shared } = await other.api.apps.create({ name: "Shared" });
    await published(shared);
    const { builder, chat } = await setUp([
      codeStep(`export default async (self, env) => {
        await env.build.write(${JSON.stringify(shared)}, ${JSON.stringify({ "screens/desk.tsx": desk })});
        return await env.build.submit(${JSON.stringify(shared)}, { kind: "check" });
      };`),
      says("Submitted."),
    ]);
    await other.api.apps.members.add(shared, {
      type: "person",
      id: builder.userId,
      role: "builder",
    });
    await chat.ask("Check the shared App");
    const job = await submittedJob(chat.stub, chat.chat.id);
    await endedJob(chat.stub, chat.chat.id, job.id);
    // They use it from now on, but no longer build it.
    await other.api.apps.members.add(shared, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          try { return (await env.build.job(${JSON.stringify(job.id)})).status; } catch (error) { return error.message; }
        };`),
      says("You no longer build that App.")
    );
    await configureObject(chat.stub);

    await chat.ask("How did that check go?");

    const results = await codeResults(chat.stub, chat.chat.id);
    const record = await chat.stub.buildJob(chat.chat.id, job.id);
    expect({ read: results.at(-1)?.text, kept: record?.id }).toStrictEqual({
      read: `Returned:\n${roleErrors.create("role.forbidden").message}`,
      kept: job.id,
    });
  });

  it("fails a check whose draft was written while it checked, with a conflict", async () => {
    const { builder, chat } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": desk })});
        return await env.build.submit(app.id, { kind: "check" });
      };`),
      says("Submitted."),
    ]);
    const checking = holdFiles(screenBuilds);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Check an invoice desk");
      job = await submittedJob(chat.stub, chat.chat.id);
      await checking.reached();
      const { app } = await createdApp(builder);
      await writtenMeanwhile(chat.stub, chat.chat.id, app.id);
    } finally {
      checking.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect({
      status: ended.status,
      result: ended.result,
      code: errorCode(ended.error),
    }).toStrictEqual({ status: "failed", result: null, code: "app.conflict" });
  });

  it("admits nothing of a job while its chat is being deleted", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    const asConnect = await personOf(env, await builder.api.whoami());
    const by = { type: "person" as const, userId: builder.userId };
    const storing = holdFiles(storedTrees);
    const declining = { reached: false, released: false };
    let deleting: Promise<unknown> | undefined;
    let ended: Awaited<ReturnType<typeof endedJob>> | undefined;
    let originalConnect: Env["CONNECT"] | undefined;
    try {
      await chat.ask("Build an invoice desk for invoices@");
      const job = await submittedJob(chat.stub, chat.chat.id);
      await storing.reached();
      // Deleting the chat waits on connect, as it declines its writes:
      // the object's own binding, wrapped, every other method as it was.
      await runInDurableObject(chat.stub, (instance) => {
        const objectEnv = envOf(instance);
        const connect = objectEnv.CONNECT;
        originalConnect = connect;
        objectEnv.CONNECT = new Proxy(connect, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (
              property !== "declineChatActions" ||
              typeof value !== "function"
            ) {
              return typeof value === "function"
                ? (...args: unknown[]): unknown =>
                    Reflect.apply(value, target, args)
                : value;
            }
            return async (...args: unknown[]): Promise<unknown> => {
              declining.reached = true;
              while (!declining.released) {
                // oxlint-disable-next-line no-await-in-loop -- until the test releases it
                await scheduler.wait(20);
              }
              return await Reflect.apply(value, target, args);
            };
          },
        });
      });
      deleting = runInDurableObject(
        chat.stub,
        async (instance) =>
          await instance.deleteChat(chat.chat.id, builder.userId, asConnect, by)
      );
      await vi.waitFor(
        () => {
          expect(declining.reached).toBeTruthy();
        },
        { timeout: 30_000, interval: 20 }
      );
      // The job goes on to its commit while the chat is being deleted.
      storing.restore();
      ended = await endedJob(chat.stub, chat.chat.id, job.id);
    } finally {
      storing.restore();
      declining.released = true;
      await deleting;
      // The object's env may be other tests' too: its binding goes back.
      const restored = originalConnect;
      if (restored !== undefined) {
        await runInDurableObject(chat.stub, (instance) => {
          envOf(instance).CONNECT = restored;
        });
      }
    }
    const { versions } = await createdApp(builder);
    expect({
      status: ended.status,
      version: ended.version,
      versions,
    }).toStrictEqual({
      status: "cancelled",
      version: null,
      versions: [],
    });
  });

  it("goes on through a restart of its chat's object, and reaches no turn", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    const checking = holdFiles(screenBuilds);
    let job: z.infer<typeof jobRowSchema>;
    let { stub } = chat;
    try {
      await chat.ask("Build an invoice desk for invoices@");
      job = await submittedJob(chat.stub, chat.chat.id);
      await checking.reached();
      await runInDurableObject(chat.stub, (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // Aborting fails the call that aborted: that is the restart.
      });
      stub = workspace(env, chat.id);
    } finally {
      checking.restore();
    }
    const ended = await endedJob(stub, chat.chat.id, job.id);
    const { versions } = await createdApp(builder);
    expect({
      status: ended.status,
      version: ended.version,
      versions: versions.length,
      stored: await jobEvents(stub, chat.chat.id, job.id),
    }).toStrictEqual({
      status: "completed",
      version: 1,
      versions: 1,
      stored: [],
    });
  });

  it("hands on nothing of a check whose agent lost a permission as it ended", async () => {
    const { admin, chat } = await setUp([
      codeStep(`export default async (self, env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": desk })});
        return await env.build.submit(app.id, { kind: "check" });
      };`),
      says("Submitted."),
    ]);
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    });
    const handbook = await requestGranted(
      idp,
      admin,
      readCollection(chat.agent, collectionId, "HANDBOOK")
    );
    const checking = holdFiles(screenBuilds);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Check an invoice desk");
      job = await submittedJob(chat.stub, chat.chat.id);
      // After its only step was admitted: its last step finds it.
      await checking.reached();
      await admin.api.permissions.revoke(handbook);
    } finally {
      checking.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect({ status: ended.status, result: ended.result }).toStrictEqual({
      status: "revoked",
      result: null,
    });
  });

  it("reads as none to another chat's code", async () => {
    const { chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    await chat.ask("Build an invoice desk for invoices@");
    const job = await submittedJob(chat.stub, chat.chat.id);
    // Another chat of the same person, with the same agent.
    const another = await chat.stub.createChat(
      "Questions",
      chat.personId,
      chat.agent.agentId
    );
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          try { return (await env.build.job(${JSON.stringify(job.id)})).status; } catch (error) { return error.message; }
        };`),
      says("There's no such job here.")
    );
    await configureObject(chat.stub);

    await chat.stub.ask(another.id, { text: "How's that build?", model });

    const [result] = await codeResults(chat.stub, another.id);
    // Its job ends within the test: one left building would hold the
    // client's builds in the next test, which counts on them.
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect({ result: result?.text, ended: ended.status }).toStrictEqual({
      result: `Returned:\n${agentErrors.create("agent.job_not_found").message}`,
      ended: "completed",
    });
  });
});
