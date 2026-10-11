import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  chatOf,
  codeStep,
  pausedReply,
  says,
  transcript,
} from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
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
    const { FILES: files } = env;
    env.FILES = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "put" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            if (typeof args[0] === "string" && args[0].includes("tests")) {
              await scheduler.wait(4000);
            }
            return await Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
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
});
