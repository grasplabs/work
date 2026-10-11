import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  chatOf,
  codeResults,
  codeStep,
  model,
  pausedReply,
  pointAtGateway,
  says,
  transcript,
} from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { signedInApi } from "./sign-in.ts";

// A build a chat's code hands to a durable job (`env.build.submit`): it
// goes on after the code run that submitted it ends, as a workflow of
// core's own, and how it ended reaches the turn that submitted it. These
// tests start from how that can go wrong: the result reaches a turn that
// has ended, or a later one; a permission revoked while the job runs
// doesn't stop what it does next; and a restart of the job makes its
// commit twice.

const idp = mockIdp();

const appName = "Invoice desk";

/** A screen the lint lets through. */
const desk = `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button variant="outline">Approve</Button>
    </main>
  );
}
`;

/** A workflow of the draft, with its tests: what a check keeps. */
const intake = {
  "workflows/intake.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("intake", { params: {}, input: z.unknown() }, async (step, { input }) => {
  return await step.do("read", { description: "Read the invoice" }, async () => input);
});
`,
  "workflows/intake.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./intake.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: { read: 1 }, expect: {} },
]);
`,
};

/** The screen with its button restyled, which @shadcn/lint refuses. */
const restyled = desk.replace(
  '<Button variant="outline">',
  '<Button className="rounded-full">'
);

/** Code that finds the App the agent created, by its name, as `app`. */
const findApp = `const [app] = (await env.apps.list()).filter(({ name }) => name === ${JSON.stringify(appName)});`;

/** The code of the error a job's record holds, if any. */
const errorCode = (error: string | null): string | null =>
  error === null
    ? null
    : z.object({ code: z.string() }).parse(JSON.parse(error)).code;

/** What a code step returned, as JSON. */
const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Creates the App, writes a draft that passes, and submits its proposal. */
const submitProposal = `export default async (self, env) => {
  const app = await env.build.create({ name: ${JSON.stringify(appName)} });
  await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": desk, ...intake })});
  return await env.build.submit(app.id, { kind: "propose", message: "An invoice desk" });
};`;

/**
 * A builder's chat answered by `replies`, with an App released so the
 * Apps collection is there, and the agent allowed to build Apps.
 */
const setUp = async (replies: GatewayReply[]) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
  await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
  const chat = await chatOf(builder.userId, ...replies);
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "collection", collectionId: "apps" },
    actions: ["read", "write"],
    binding: "APP_LIBRARY",
  });
  return { admin, builder, chat };
};

/**
 * Holds every call `held` picks to core's files (`env.FILES`) until
 * released: `reached` resolves once the first is held. The calls of a
 * job's step that it picks wait there, so a test acts while the job is
 * in that step. Set back with `restore`. The held call waits in its own
 * request, on flags, never on a promise of the test's request, which
 * workerd won't let another request wait on.
 */
const holdFiles = (held: (method: string, key: unknown) => boolean) => {
  const { FILES: files } = env;
  const state = { reached: false, released: false };
  env.FILES = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof property === "string" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (held(property, args[0])) {
            state.reached = true;
            while (!state.released) {
              // oxlint-disable-next-line no-await-in-loop -- until the test releases it
              await scheduler.wait(20);
            }
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return value;
    },
  });
  return {
    reached: async () => {
      await vi.waitFor(
        () => {
          expect(state.reached).toBeTruthy();
        },
        { timeout: 60_000, interval: 20 }
      );
    },
    restore: () => {
      state.released = true;
      env.FILES = files;
    },
  };
};

/**
 * Makes every write of a check's test results to core's files take `ms`
 * longer: the files as they were, to set back.
 */
const slowTestResults = (ms: number): typeof env.FILES => {
  const { FILES: files } = env;
  env.FILES = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "put" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (typeof args[0] === "string" && args[0].includes("tests")) {
            await scheduler.wait(ms);
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return files;
};

/** A job's check, building the draft's screens: no code run builds them. */
const screenBuilds = (method: string, key: unknown): boolean =>
  method === "get" &&
  typeof key === "string" &&
  key.startsWith("screen-builds/");

const jobRowSchema = z.object({ id: z.string(), status: z.string() });

/** The chat's one build job, once its code submitted it. */
const submittedJob = async (stub: WorkspaceStub, chatId: string) =>
  await vi.waitFor(
    async () => {
      const rows = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT id, status FROM chat_build_jobs WHERE chat_id = ?",
            chatId
          )
          .toArray()
      );
      expect(rows).toHaveLength(1);
      return jobRowSchema.parse(rows[0]);
    },
    { timeout: 30_000, interval: 50 }
  );

/** The chat's job `id` once it has ended, however it ended. */
const endedJob = async (stub: WorkspaceStub, chatId: string, id: string) =>
  await vi.waitFor(
    async () => {
      const job = await stub.buildJob(chatId, id);
      expect(job?.status).not.toBe("running");
      if (job === undefined) {
        throw new Error("The job is gone");
      }
      return job;
    },
    { timeout: 90_000, interval: 100 }
  );

/** How the chat's code runs ended, as their records say, and when. */
const runRecords = async (stub: WorkspaceStub, chatId: string) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ status: string; ended_at: number | null }>(
        "SELECT status, ended_at FROM chat_code_runs WHERE chat_id = ? ORDER BY started_at",
        chatId
      )
      .toArray()
  );

/** The App the agent created, with its versions. */
const createdApp = async (builder: Awaited<ReturnType<typeof signedInApi>>) => {
  const apps = await builder.api.apps.list();
  const app = apps.find(({ name }) => name === appName);
  if (app === undefined) {
    throw new Error("The agent created no App");
  }
  return {
    app,
    versions: await builder.api.apps.versions.list(app.id),
  };
};

/** The system messages of the chat that name the job `id`. */
const jobEvents = async (stub: WorkspaceStub, chatId: string, id: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message, index) =>
    message.role === "system" && JSON.stringify(message.content).includes(id)
      ? [{ index, content: JSON.stringify(message.content) }]
      : []
  );
};

describe("build jobs", { timeout: 180_000 }, () => {
  it("finishes a proposal after the run that submitted it ended, and tells that turn how it ended", async () => {
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
    const waited = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) => part.type === "text" && part.text.startsWith("I'll say")
        )
    );
    const { app, versions } = await createdApp(builder);
    const told = await jobEvents(chat.stub, chat.chat.id, job.id);
    expect({
      answer,
      // Told once, right after the answer it gave while the job ran.
      events: told.map(({ index, content }) => ({
        index,
        byItsRun: content.includes("submitted by code run"),
      })),
      last: messages.at(-1)?.role,
      // The model was sent it with its last request.
      sent: JSON.stringify(chat.gateway.requests.at(-1)?.body).includes(job.id),
      // It proposed the draft once, as the chat's agent, for review.
      app: { pending: app.pendingVersion, current: app.currentVersion },
      versions: versions.map(({ version, proposedBy }) => ({
        version,
        chat: proposedBy?.chatId,
      })),
    }).toMatchObject({
      answer: {
        outcome: "answered",
        answer: "The invoice desk is proposed for review.",
      },
      events: [
        {
          index: waited + 1,
          byItsRun: true,
        },
      ],
      last: "assistant",
      sent: true,
      app: { pending: 1, current: null },
      versions: [{ version: 1, chat: chat.chat.id }],
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
          expect(chat.gateway.requests).toHaveLength(3);
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
    expect(chat.gateway.requests).toHaveLength(3);
    // What it came to is on its record, for the agent to read.
    const { versions } = await createdApp(builder);
    expect(versions).toHaveLength(1);
  });

  it("refuses a job's commit once a permission of its agent was revoked while it ran", async () => {
    const { admin, builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    // Another permission of the agent's, which building doesn't need.
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
      await chat.ask("Build an invoice desk for invoices@");
      job = await submittedJob(chat.stub, chat.chat.id);
      // Revoked while it checks the draft, before it would commit.
      await checking.reached();
      expect(job.status).toBe("running");
      await admin.api.permissions.revoke(handbook);
    } finally {
      checking.restore();
    }

    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect(ended).toMatchObject({
      status: "revoked",
      version: null,
      result: null,
    });
    // Nothing was committed, and the refusal is in the audit log.
    const { app, versions } = await createdApp(builder);
    expect(versions).toStrictEqual([]);
    expect(app.pendingVersion).toBeNull();
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events.some(
            ({ action, detail }) =>
              action === "agent.call" &&
              detail.chat === chat.chat.id &&
              detail.job === job.id &&
              detail.reason === "agent.job_revoked"
          )
        ).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 }
    );
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

  it("commits once when the engine runs a job's commit again after it committed", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    // Keeping the check's test results, after the commit and before the
    // job records its receipt, takes seconds: long enough to cut it off.
    const files = slowTestResults(4000);
    try {
      await chat.ask("Build an invoice desk for invoices@");
      const job = await submittedJob(chat.stub, chat.chat.id);
      // Committed, its step not finished: the engine runs it again.
      await vi.waitFor(
        async () => {
          const { versions } = await createdApp(builder);
          expect(versions).toHaveLength(1);
        },
        { timeout: 60_000, interval: 50 }
      );
      const committing = await chat.stub.buildJob(chat.chat.id, job.id);
      expect(committing?.status).toBe("running");
      const instance = await env.WORKFLOWS.get(job.id);
      await instance.restart({ from: { name: "commit" } });

      const ended = await endedJob(chat.stub, chat.chat.id, job.id);
      expect(ended).toMatchObject({ status: "completed", version: 1 });
      const { app, versions } = await createdApp(builder);
      expect(versions).toHaveLength(1);
      expect(app.pendingVersion).toBe(1);
      await vi.waitFor(
        async () => {
          const events = await allEvents();
          expect(
            events.filter(
              ({ action, target }) =>
                action === "app.committed" && target?.id === app.id
            )
          ).toHaveLength(1);
        },
        { timeout: 10_000, interval: 50 }
      );
    } finally {
      env.FILES = files;
    }
  });

  it("keeps the version a commit landed with when the job is revoked before its commit runs again", async () => {
    const { admin, builder, chat } = await setUp([
      codeStep(submitProposal),
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
    // The first try is still keeping test results, its receipt unrecorded,
    // long after its second try has ended.
    const files = slowTestResults(20_000);
    try {
      await chat.ask("Build an invoice desk for invoices@");
      const job = await submittedJob(chat.stub, chat.chat.id);
      await vi.waitFor(
        async () => {
          const { versions } = await createdApp(builder);
          expect(versions).toHaveLength(1);
        },
        { timeout: 60_000, interval: 50 }
      );
      await admin.api.permissions.revoke(handbook);
      const instance = await env.WORKFLOWS.get(job.id);
      await instance.restart({ from: { name: "commit" } });

      // Refused, but what it committed stays its receipt.
      const ended = await endedJob(chat.stub, chat.chat.id, job.id);
      const { versions } = await createdApp(builder);
      expect({ ended, versions: versions.length }).toMatchObject({
        ended: { status: "revoked", version: 1, result: null },
        versions: 1,
      });
    } finally {
      env.FILES = files;
    }
  });

  it("counts job checks with the repair loop, and refuses a sixth once five failed in a row", async () => {
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
      ...[1, 2, 3, 4, 5].map((failedInARow) => ({
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
      const jobs = z.array(z.string()).parse(submitted);
      const [first] = jobs;
      // Its instance ends behind the record's back: the record still runs.
      const instance = await env.WORKFLOWS.get(first ?? "");
      await instance.terminate();
      waiting.release();
      await answering;
      const results = await codeResults(chat.stub, chat.chat.id);
      fifth = results[1]?.text;
      ended = await endedJob(chat.stub, chat.chat.id, first ?? "");
    } finally {
      checking.restore();
    }
    const exhausted = agentErrors.create("agent.jobs_exhausted").message;
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

  it("commits nothing once its chat turned restricted while the job checked", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    const checking = holdFiles(screenBuilds);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Build an invoice desk for invoices@");
      job = await submittedJob(chat.stub, chat.chat.id);
      await checking.reached();
      await chat.stub.restrictChat(chat.chat.id);
    } finally {
      checking.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    const { versions } = await createdApp(builder);
    expect({
      status: ended.status,
      version: ended.version,
      code: errorCode(ended.error),
      versions,
    }).toStrictEqual({
      status: "failed",
      version: null,
      code: "permission.restricted",
      versions: [],
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
    await pointAtGateway(
      chat.stub,
      fakeGateway(
        codeStep(`export default async (self, env) => {
          try { return (await env.build.job(${JSON.stringify(job.id)})).status; } catch (error) { return error.message; }
        };`),
        says("There's no such job here.")
      )
    );

    await chat.stub.ask(another.id, { text: "How's that build?", model });

    const [result] = await codeResults(chat.stub, another.id);
    expect(result?.text).toBe(
      `Returned:\n${agentErrors.create("agent.job_not_found").message}`
    );
  });
});
