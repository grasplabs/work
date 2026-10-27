import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { codeResults, codeStep, pointAtGateway, says } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { published, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { collectionWithNote, readCollection } from "./brain-collections.ts";
import type { jobRowSchema } from "./build-jobs.ts";
import {
  desk,
  errorCode,
  returned,
  submitProposal,
  holdFiles,
  slowTestResults,
  storedTrees,
  writtenMeanwhile,
  screenBuilds,
  submittedJob,
  endedJob,
  createdApp,
  buildJobsOf,
} from "./build-jobs.ts";
import { mockIdp } from "./idp.ts";
import { runInstance } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";

// A build a chat's code hands to a durable job (`env.build.submit`): it
// goes on after the code run that submitted it ends, as a workflow of
// core's own, and how it ended reaches the turn that submitted it. These
// tests start from how that can go wrong: the result reaches a turn that
// has ended, or a later one; a permission revoked while the job runs
// doesn't stop what it does next; and a restart of the job makes its
// commit twice.

// Here: a job's commit, once, and nothing once what it commits for no
// longer stands; the rest of a job is build-job-runs.test.ts's.

const idp = mockIdp();
const { setUp } = buildJobsOf(idp);

describe("build jobs", { timeout: 180_000 }, () => {
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
    await published(shared);
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
});
