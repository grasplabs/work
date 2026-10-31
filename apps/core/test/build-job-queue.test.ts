import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { checkFiles } from "../src/agent-builds.ts";
import { queuedJob } from "../src/build-admission.ts";
import {
  codeResults,
  codeStep,
  pausedReply,
  configureObject,
  says,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import {
  desk,
  intake,
  submitProposal,
  holdFiles,
  storedTrees,
  submittedJob,
  endedJob,
  createdApp,
  queuedForClient,
  policyWith,
  buildJobsOf,
} from "./build-jobs.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";

// A build a chat's code hands to a durable job (`env.build.submit`): it
// goes on after the code run that submitted it ends, as a workflow of
// core's own, and how it ended reaches the turn that submitted it. These
// tests start from how that can go wrong: the result reaches a turn that
// has ended, or a later one; a permission revoked while the job runs
// doesn't stop what it does next; and a restart of the job makes its
// commit twice.

// Here: a job's place in the client's builds, and its lease on its
// App's build; the rest of a job is build-job-runs.test.ts's.

const { setUp } = buildJobsOf(mockIdp());

describe("build jobs", { timeout: 180_000 }, () => {
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
          await fakeProvider(
            codeStep(`export default async (self, env) => {
                const { status, queued } = await env.build.job(${JSON.stringify(job.id)});
                return { status, waitingFor: queued?.waitingFor ?? null };
              };`),
            says("It waits its turn.")
          );
          await configureObject(chat.stub);
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
