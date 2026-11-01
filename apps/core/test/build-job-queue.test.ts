import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { checkFiles } from "../src/agent-builds.ts";
import { buildsAtOnce } from "../src/build-admission.ts";
import { codeStep, says } from "./agent-chat.ts";
import {
  desk,
  intake,
  submitProposal,
  submittedJob,
  endedJob,
  createdApp,
  buildJobsOf,
} from "./build-jobs.ts";
import { mockIdp } from "./idp.ts";
import { runObject } from "./runs.ts";

// A build a chat's code hands to a durable job (`env.build.submit`): it
// goes on after the code run that submitted it ends, as a workflow of
// core's own, and how it ended reaches the turn that submitted it. These
// tests start from how that can go wrong: the result reaches a turn that
// has ended, or a later one; a permission revoked while the job runs
// doesn't stop what it does next; and a restart of the job makes its
// commit twice.

// Here: a job's lease of the builds running at once (build-admission.ts);
// the rest of a job is build-job-runs.test.ts's.

const { setUp } = buildJobsOf(mockIdp());

describe("build jobs", { timeout: 180_000 }, () => {
  it("wait, running and not failed, while every build slot is taken, and build once one frees", async () => {
    // Other jobs hold every build slot.
    const others = Array.from({ length: buildsAtOnce }, () =>
      crypto.randomUUID()
    );
    await env.DB.batch(
      others.map((other) =>
        env.DB.prepare(
          "INSERT INTO build_leases (job_id, seq, admitted_at, reserved_ms, settled_at) VALUES (?, 1, ?, 600000, NULL)"
        ).bind(other, Date.now())
      )
    );
    try {
      const { builder, chat } = await setUp([
        codeStep(submitProposal),
        says("Submitted."),
      ]);
      await chat.ask("Build an invoice desk for invoices@");
      const job = await submittedJob(chat.stub, chat.chat.id);
      // It asked for a slot and was told to wait: its first round sleeps.
      await vi.waitFor(
        async () => {
          await expect(
            runInDurableObject(runObject(job.id), (_object, state) =>
              state.storage.sql
                .exec<{ n: number }>(
                  "SELECT count(*) AS n FROM steps WHERE type = 'sleep' AND name LIKE 'check.queued.%'"
                )
                .one()
            )
          ).resolves.toStrictEqual({ n: 1 });
        },
        { timeout: 30_000, interval: 200 }
      );
      const whileWaiting = await chat.stub.buildJob(chat.chat.id, job.id);
      await env.DB.prepare(
        "UPDATE build_leases SET settled_at = ? WHERE job_id = ?"
      )
        .bind(Date.now(), others[0])
        .run();
      const ended = await endedJob(chat.stub, chat.chat.id, job.id);
      const { versions } = await createdApp(builder);
      const held = await env.DB.prepare(
        "SELECT count(*) AS held FROM build_leases WHERE job_id = ? AND settled_at IS NULL"
      )
        .bind(job.id)
        .first<number>("held");
      expect({
        whileWaiting: whileWaiting?.status,
        status: ended.status,
        versions: versions.length,
        held,
      }).toStrictEqual({
        whileWaiting: "running",
        status: "completed",
        versions: 1,
        // Each step gave its lease back as it ended.
        held: 0,
      });
    } finally {
      await env.DB.batch(
        others.map((other) =>
          env.DB.prepare("DELETE FROM build_leases WHERE job_id = ?").bind(
            other
          )
        )
      );
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
});
