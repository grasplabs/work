import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { roleErrors } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { checkFiles } from "../src/agent-builds.ts";
import { queuedJob } from "../src/build-admission.ts";
import { BuildJobRecords, jobRecordsKept } from "../src/build-job-records.ts";
import { personOf } from "../src/connections.ts";
import { workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  openTestRun,
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
import { runInstance } from "./runs.ts";
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
  "workflows/intake.ts": `import { type Json, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("intake", { params: {}, input: z.unknown() }, async (step, { input }) => {
  return await step.do("read", { description: "Read the invoice" }, async () => input as Json);
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

/** A Workspace object's own env, to change a binding of it in a test. */
const envOf = (instance: object): Pick<Env, "CONNECT"> => {
  const objectEnv: unknown = Reflect.get(instance, "env");
  if (typeof objectEnv !== "object" || objectEnv === null) {
    throw new TypeError("The Workspace object has no env");
  }
  // SAFETY: a Workspace object's env is core's Env, which has CONNECT.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return objectEnv as Pick<Env, "CONNECT">;
};

/** A commit storing a version's files: no code run commits. */
const storedTrees = (method: string, key: unknown): boolean =>
  method === "put" && typeof key === "string" && key.includes("/trees/");

/**
 * Writes the chat's draft of `app` from a run of its own, as the chat's
 * code would in another step: a new revision of the draft.
 */
const writtenMeanwhile = async (
  stub: WorkspaceStub,
  chatId: string,
  app: string
): Promise<void> => {
  const id = chatIdSchema.parse(chatId);
  const draft = await stub.draft(id, app);
  const run = await openTestRun(stub, id);
  const saved = await stub.saveDraft(
    id,
    app,
    draft.base,
    { ...draft.changes, "screens/note.tsx": desk },
    [],
    draft.revision,
    run
  );
  expect(saved).toBeTruthy();
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

/** What a job's own code reads of it while it waits for the client's share. */
const queuedForClient = /"status":\s*"queued",\s*"waitingFor":\s*"client"/u;

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/** The generation of the next policy a test sets: each higher than before. */
let generations = 500;

/** Sets the operator's policy to the deployment's, with `limits` lowered. */
const policyWith = (limits: Record<string, number>): void => {
  generations += 1;
  env.QUOTA_LIMITS = {
    generation: generations,
    limits: { ...configuredLimits, ...limits },
  };
};

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
    const lastRequest = JSON.stringify(chat.gateway.requests.at(-1)?.body);
    // A later turn of the chat.
    const later = fakeGateway(says("Anything else?"));
    await pointAtGateway(chat.stub, later);
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
      const instance = runInstance(job.id);
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
      const instance = runInstance(job.id);
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
    await pointAtGateway(
      chat.stub,
      fakeGateway(
        codeStep(`export default async (self, env) => {
          try { return (await env.build.job(${JSON.stringify(job.id)})).status; } catch (error) { return error.message; }
        };`),
        says("You no longer build that App.")
      )
    );

    await chat.ask("How did that check go?");

    const results = await codeResults(chat.stub, chat.chat.id);
    const record = await chat.stub.buildJob(chat.chat.id, job.id);
    expect({ read: results.at(-1)?.text, kept: record?.id }).toStrictEqual({
      read: `Returned:\n${roleErrors.create("role.forbidden").message}`,
      kept: job.id,
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

  it("commits nothing when its person stops building the App while its files are stored", async () => {
    const other = await signedInApi(idp, "builder");
    const { id: shared } = await other.api.apps.create({ name: "Shared" });
    const { builder, chat } = await setUp([
      codeStep(`export default async (self, env) => {
        await env.build.write(${JSON.stringify(shared)}, ${JSON.stringify({ "screens/desk.tsx": desk })});
        return await env.build.submit(${JSON.stringify(shared)}, { kind: "propose", message: "A desk" });
      };`),
      says("Submitted."),
    ]);
    await other.api.apps.members.add(shared, {
      type: "person",
      id: builder.userId,
      role: "builder",
    });
    const storing = holdFiles(storedTrees);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Propose the shared App");
      job = await submittedJob(chat.stub, chat.chat.id);
      await storing.reached();
      await other.api.apps.members.add(shared, {
        type: "person",
        id: builder.userId,
        role: "user",
      });
    } finally {
      storing.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    const versions = await other.api.apps.versions.list(shared);
    expect({
      status: ended.status,
      version: ended.version,
      code: errorCode(ended.error),
      versions,
    }).toStrictEqual({
      status: "failed",
      version: null,
      code: "role.forbidden",
      versions: [],
    });
  });

  it("commits nothing when its chat turns restricted while its files are stored", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    const storing = holdFiles(storedTrees);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Build an invoice desk for invoices@");
      job = await submittedJob(chat.stub, chat.chat.id);
      await storing.reached();
      await chat.stub.restrictChat(chat.chat.id);
    } finally {
      storing.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    const { versions } = await createdApp(builder);
    expect({
      status: ended.status,
      code: errorCode(ended.error),
      versions,
    }).toStrictEqual({
      status: "failed",
      code: "permission.restricted",
      versions: [],
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

  it("commits nothing when its draft is written while its files are stored", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    const storing = holdFiles(storedTrees);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Build an invoice desk for invoices@");
      job = await submittedJob(chat.stub, chat.chat.id);
      await storing.reached();
      const { app } = await createdApp(builder);
      await writtenMeanwhile(chat.stub, chat.chat.id, app.id);
    } finally {
      storing.restore();
    }
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    const { versions } = await createdApp(builder);
    expect({
      status: ended.status,
      code: errorCode(ended.error),
      versions,
    }).toStrictEqual({ status: "failed", code: "app.conflict", versions: [] });
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

  it("says a job that broke off after its commit committed, and never to submit it again", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    // The commit's step is still keeping test results when its instance
    // ends, its receipt unrecorded.
    const files = slowTestResults(20_000);
    let job: z.infer<typeof jobRowSchema>;
    try {
      await chat.ask("Build an invoice desk for invoices@");
      job = await submittedJob(chat.stub, chat.chat.id);
      await vi.waitFor(
        async () => {
          const { versions } = await createdApp(builder);
          expect(versions).toHaveLength(1);
        },
        { timeout: 60_000, interval: 50 }
      );
      const instance = runInstance(job.id);
      await instance.terminate();
      await pointAtGateway(
        chat.stub,
        fakeGateway(
          codeStep(`export default async (self, env) => {
            const { status, version, error } = await env.build.job(${JSON.stringify(job.id)});
            return { status, version, error };
          };`),
          says("It was proposed.")
        )
      );
      await chat.ask("How did it go?");
    } finally {
      env.FILES = files;
    }
    const results = await codeResults(chat.stub, chat.chat.id);
    const read = z
      .object({
        status: z.string(),
        version: z.number().nullable(),
        error: z.object({ code: z.string(), message: z.string() }),
      })
      .parse(returned(results.at(-1)?.text));
    expect({
      status: read.status,
      version: read.version,
      committed: read.error.message.includes("after committing version 1"),
      submitAgain: read.error.message.includes("Submit it again"),
    }).toStrictEqual({
      status: "failed",
      version: 1,
      committed: true,
      submitAgain: false,
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
    // Its job ends within the test: one left building would hold the
    // client's builds in the next test, which counts on them.
    const ended = await endedJob(chat.stub, chat.chat.id, job.id);
    expect({ result: result?.text, ended: ended.status }).toStrictEqual({
      result: `Returned:\n${agentErrors.create("agent.job_not_found").message}`,
      ended: "completed",
    });
  });

  it("queues a job while the client's builds are full, shows it queued, not failed, and builds it once a share frees", async () => {
    policyWith({ tenantBuildJobs: 1 });
    // Another App's job holds the client's one build.
    const other = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO build_leases (job_id, seq, subject, resource, admitted_at, reserved_ms, settled_at, policy_generation) VALUES (?, 1, 'someone-else', 'another-app', ?, 600000, NULL, 0)"
    )
      .bind(other, Date.now())
      .run();
    try {
      const { builder, chat } = await setUp([
        codeStep(submitProposal),
        says("Submitted."),
      ]);
      await chat.ask("Build an invoice desk for invoices@");
      const job = await submittedJob(chat.stub, chat.chat.id);
      // Its own code reads it queued, waiting for the client's share.
      await vi.waitFor(
        async () => {
          await pointAtGateway(
            chat.stub,
            fakeGateway(
              codeStep(`export default async (self, env) => {
                const { status, queued } = await env.build.job(${JSON.stringify(job.id)});
                return { status, waitingFor: queued?.waitingFor ?? null };
              };`),
              says("It waits its turn.")
            )
          );
          await chat.ask("How's that build?");
          const results = await codeResults(chat.stub, chat.chat.id);
          expect(results.at(-1)?.text).toMatch(queuedForClient);
        },
        { timeout: 30_000, interval: 200 }
      );
      const whileQueued = await chat.stub.buildJob(chat.chat.id, job.id);
      await env.DB.prepare(
        "UPDATE build_leases SET settled_at = ? WHERE job_id = ?"
      )
        .bind(Date.now(), other)
        .run();
      const ended = await endedJob(chat.stub, chat.chat.id, job.id);
      const { versions } = await createdApp(builder);
      const held = await env.DB.prepare(
        "SELECT count(*) AS held FROM build_leases WHERE job_id = ? AND settled_at IS NULL"
      )
        .bind(job.id)
        .first<number>("held");
      const events = await allEvents();
      const joins = events.filter(
        ({ action, detail }) =>
          action === "agent.call" &&
          detail.method === "build.job.queued" &&
          detail.job === job.id
      );
      expect({
        whileQueued: whileQueued?.status,
        status: ended.status,
        versions: versions.length,
        held,
        joins: joins.map(({ detail }) => detail.waitingFor),
      }).toStrictEqual({
        whileQueued: "running",
        status: "completed",
        versions: 1,
        // Each step gave its lease back as it ended.
        held: 0,
        // Recorded once, as it joined the queue, however often it asked.
        joins: ["client"],
      });
    } finally {
      policyWith({});
      await env.DB.prepare("DELETE FROM build_leases WHERE job_id = ?")
        .bind(other)
        .run();
    }
  });

  it("commits nothing once its lease lapsed and another job of its App took the App's build, and commits once it has a share again", async () => {
    const { builder, chat } = await setUp([
      codeStep(submitProposal),
      says("Submitted."),
    ]);
    const storing = holdFiles(storedTrees);
    const other = crypto.randomUUID();
    try {
      await chat.ask("Build an invoice desk for invoices@");
      const job = await submittedJob(chat.stub, chat.chat.id);
      await storing.reached();
      const record = await chat.stub.buildJob(chat.chat.id, job.id);
      // The commit stalled past its lease, and another job of the App took
      // the App's one build since.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE build_leases SET admitted_at = admitted_at - 700000 WHERE job_id = ?"
        ).bind(job.id),
        env.DB.prepare(
          "INSERT INTO build_leases (job_id, seq, subject, resource, admitted_at, reserved_ms, settled_at, policy_generation) VALUES (?, 1, 'someone-else', ?, ?, 600000, NULL, 0)"
        ).bind(other, record?.appId ?? "", Date.now()),
      ]);
      storing.restore();
      // Its files stored, its commit's fence refuses it; the engine tries
      // the step again, which waits for the App's share.
      await vi.waitFor(
        async () => {
          const events = await allEvents();
          expect(
            events.some(
              ({ action, detail }) =>
                action === "agent.call" &&
                detail.method === "build.job.queued" &&
                detail.job === job.id &&
                detail.waitingFor === "key"
            )
          ).toBeTruthy();
        },
        { timeout: 60_000, interval: 500 }
      );
      const meanwhile = await createdApp(builder);
      const running = await chat.stub.buildJob(chat.chat.id, job.id);
      const whileTheOtherBuilds = {
        versions: meanwhile.versions.length,
        status: running?.status,
      };
      await env.DB.prepare(
        "UPDATE build_leases SET settled_at = ? WHERE job_id = ?"
      )
        .bind(Date.now(), other)
        .run();
      const ended = await endedJob(chat.stub, chat.chat.id, job.id);
      const { versions } = await createdApp(builder);
      expect({
        whileTheOtherBuilds,
        ended: { status: ended.status, version: ended.version },
        versions: versions.length,
      }).toStrictEqual({
        whileTheOtherBuilds: { versions: 0, status: "running" },
        ended: { status: "completed", version: 1 },
        versions: 1,
      });
    } finally {
      storing.restore();
      await env.DB.prepare("DELETE FROM build_leases WHERE job_id = ?")
        .bind(other)
        .run();
    }
  });

  it("starts no build of a check once its lease was lost while it read the draft", async () => {
    // The lease was lost while the step's read of the draft was pending:
    // by the time the check would build, the step's signal is aborted.
    const lost = new AbortController();
    lost.abort(new Error("The build job's step lost its lease"));
    const touched: string[] = [];
    const { FILES: files } = env;
    env.FILES = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof property === "string" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            touched.push(property);
            return await Reflect.apply(value, target, args);
          };
        }
        return value;
      },
    });
    let stopped: string;
    try {
      await checkFiles(
        env,
        {
          workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
          chatId: chatIdSchema.parse(crypto.randomUUID()),
        },
        appIdSchema.parse(crypto.randomUUID()),
        { base: null, revision: 1 },
        { "screens/desk.tsx": desk, ...intake },
        lost.signal
      );
      stopped = "built";
    } catch (error) {
      stopped = error instanceof Error ? error.message : String(error);
    } finally {
      env.FILES = files;
    }
    expect({ stopped, touched }).toStrictEqual({
      stopped: "The build job's step lost its lease",
      touched: [],
    });
  });

  it("gives up a cancelled job's place in the queue at once", async () => {
    policyWith({ tenantBuildJobs: 1 });
    // Another App's job holds the client's one build.
    const other = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO build_leases (job_id, seq, subject, resource, admitted_at, reserved_ms, settled_at, policy_generation) VALUES (?, 1, 'someone-else', 'another-app', ?, 600000, NULL, 0)"
    )
      .bind(other, Date.now())
      .run();
    const waiting = pausedReply(says("I'll say once the build is done."), 3);
    const { chat } = await setUp([codeStep(submitProposal), waiting.reply]);
    const answering = chat.ask("Build an invoice desk for invoices@");
    try {
      const job = await submittedJob(chat.stub, chat.chat.id);
      await vi.waitFor(
        async () => {
          await expect(queuedJob(env, job.id)).resolves.not.toBeNull();
        },
        { timeout: 30_000, interval: 100 }
      );
      await chat.stub.cancel(chat.chat.id, chat.personId);
      // Gone well before a place would lapse on its own.
      await vi.waitFor(
        async () => {
          const place = await env.DB.prepare(
            "SELECT count(*) AS places FROM build_admission_queue WHERE job_id = ?"
          )
            .bind(job.id)
            .first<number>("places");
          expect(place).toBe(0);
        },
        { timeout: 10_000, interval: 100 }
      );
    } finally {
      waiting.release();
      await answering;
      policyWith({});
      await env.DB.prepare("DELETE FROM build_leases WHERE job_id = ?")
        .bind(other)
        .run();
    }
  });
});
