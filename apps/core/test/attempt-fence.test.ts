import { toHex } from "@grasp-os/shared/encoding";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { WorkflowCalls } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { runBindingsFor } from "../src/bindings.ts";
import type { CollectionBinding } from "../src/knowledge/binding.ts";
import {
  AttemptHost,
  attemptCallLabels,
} from "../src/workflows/attempt-host.ts";
import type { Settled } from "../src/workflows/code.ts";
import { RunHost } from "../src/workflows/host.ts";
import { keepMessage } from "../src/workflows/kept-email.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { engineOfTest } from "./run-host.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// What leaves the host for an attempt's code passes one fence
// (attempt-host.ts): checked as each call starts and again as it returns,
// with what the call records conditional on the run going on in its own
// write. What could go wrong: a run cancelled while a call awaits a read,
// its audit write, or a binding, and the call still handing back what it
// read, or recording an ask nobody will see. So each call below is
// cancelled at each of its awaited stages in turn, the first database
// read, the next, and so on, and at the binding it awaits: each time it
// hands back nothing, and records no ask or read. On the host a run's code
// calls, with an engine of the test's own, as the platform's.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** A message from Ben with one PDF attachment, `%PDF-`. */
const mail = [
  "From: Ben <ben@acme.test>",
  "To: scans@grasp.test",
  "Subject: Scan",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  'Content-Type: application/pdf; name="scan.pdf"',
  'Content-Disposition: attachment; filename="scan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0=",
  "--b--",
  "",
].join("\r\n");

/** What the audit outbox's background drain runs. */
const outboxDrain = /FROM audit_outbox ORDER BY|DELETE FROM audit_outbox/u;

/**
 * A run of `app` acting for `userId`, with its row, held to `calls`, on a
 * database that cancels it as the `stage`th statement prepared once armed
 * runs (or never, for none): the attempt's lease is taken away, as the
 * engine does, and the run's cancel written, as `cancelRun` does, before
 * that statement runs. `stages()` counts the statements prepared since
 * armed.
 */
const runOf = async (
  app: string,
  userId: string,
  calls: WorkflowCalls,
  stage?: number,
  leaseKept = false
) => {
  const runId = runIdSchema.parse(crypto.randomUUID());
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'tidy', 1, ?, 'running', ?)"
  )
    .bind(runId, app, userId, Date.now())
    .run();
  const { step, leaseOf, leases } = engineOfTest();
  let armed = false;
  let prepared = 0;
  let cancelling: Promise<unknown> | undefined;
  const cancel = async (): Promise<void> => {
    // The engine hears of a cancel after its tombstone is written: kept,
    // the attempt still holds as the cancel lands.
    if (!leaseKept) {
      leases.clear();
    }
    await env.DB.prepare(
      "UPDATE workflow_runs SET cancel_requested_at = ? WHERE id = ?"
    )
      .bind(Date.now(), runId)
      .run();
  };
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string) => {
          // The call's own statements, not the outbox's drain, which runs
          // in the background after a write.
          if (armed && !outboxDrain.test(query)) {
            prepared += 1;
            if (prepared === stage) {
              cancelling = cancel();
            }
          }
          return target.prepare(query);
        };
      }
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await cancelling;
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
  const authority = authoritySchema.parse({
    subject: { type: "app", appId: app },
    onBehalfOf: userId,
    mode: "workflow",
    appVersion: 1,
  });
  const { bindings } = await runBindingsFor(env, authority, {
    type: "run",
    appId: appIdSchema.parse(app),
    runId,
  });
  const host = (collections: Record<string, Fetcher<CollectionBinding>>) =>
    new RunHost(
      { ...env, DB: db },
      step,
      {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("tidy"),
        version: 1,
        runId,
        authority,
        collections,
        connections: {},
        apps: {},
        calls,
      },
      {
        stepFailed: () => {},
        busyRefusals: new Map(),
        leaseOf,
        tampered: () => {},
        waiting: async () => {
          await Promise.resolve();
        },
        callApp: () => {
          throw new Error("No App call here");
        },
      }
    );
  return {
    runId,
    bindings,
    host,
    cancel,
    arm: () => {
      armed = true;
    },
    stages: () => prepared,
    settled: async () => {
      await cancelling;
    },
  };
};

/** A settled call's error code, or `ok`. */
const codeOf = (settled: Settled<unknown>): string =>
  settled.ok ? "ok" : (settled.error.code ?? settled.error.message);

/** The actions the audit log has of `run`. */
const actionsOf = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events
    .filter(({ target }) => target?.id === run)
    .map(({ action }) => action);
};

/**
 * Runs `call` in a step of a run of `app` cancelled at stage `stage` (none
 * when absent), with the run's host as `host` makes it from the run's
 * collection bindings; what it answered, and the run's ID.
 */
const cancelledAt = async (
  app: string,
  userId: string,
  calls: WorkflowCalls,
  stage: number | undefined,
  call: (attempt: AttemptHost, arm: () => void) => Promise<Settled<unknown>>,
  collections?: (
    bindings: Record<string, Fetcher<CollectionBinding>>,
    cancel: () => Promise<void>
  ) => Record<string, Fetcher<CollectionBinding>>,
  leaseKept = false
) => {
  const run = await runOf(app, userId, calls, stage, leaseKept);
  let answered: Settled<unknown> = { ok: true, value: null };
  let atReturn = 0;
  await run
    .host(collections?.(run.bindings, run.cancel) ?? run.bindings)
    .do("tidy", { description: "Tidy" }, async (attempt) => {
      answered = await call(attempt, run.arm);
      atReturn = run.stages();
      return { ok: true, value: null };
    });
  await run.settled();
  return { answered, run: run.runId, stages: atReturn };
};

/**
 * A run's HANDBOOK, its run cancelled as `getDocument` starts, or as it
 * answers: the collection's own read, in the middle of the call.
 */
const cancelledAround =
  (when: "starts" | "answers") =>
  (
    bindings: Record<string, Fetcher<CollectionBinding>>,
    cancel: () => Promise<void>
  ): Record<string, Fetcher<CollectionBinding>> => {
    const handbook = bindings.HANDBOOK;
    if (handbook === undefined) {
      throw new Error("The run has no HANDBOOK");
    }
    const around = new Proxy(handbook, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key);
        if (key !== "getDocument" || typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]) => {
          if (when === "starts") {
            await cancel();
          }
          const answer: unknown = await Reflect.apply(value, target, args);
          if (when === "answers") {
            await cancel();
          }
          return answer;
        };
      },
    });
    return { HANDBOOK: around };
  };

describe(
  "an attempt's calls, cancelled while they await",
  { timeout: 60_000 },
  () => {
    it("hand back no decision's recipients and record no ask, cancelled at any stage", async () => {
      const admin = await personApi("admin");
      const app = await appWith(admin, {});
      const calls = { steps: { tidy: [] }, all: [] };
      // Opens the decision, then asks who it asks, armed only for the asking.
      const ask = async (attempt: AttemptHost, arm: () => void) => {
        const opened = await attempt.openDecision({
          step: "tidy",
          from: `person:${admin.userId}`,
          description: "Approve the invoice",
          timeout: 60_000,
        });
        if (!opened.ok) {
          return opened;
        }
        arm();
        return await attempt.decisionRecipients(opened.value.decision, false);
      };
      const uncancelled = await cancelledAt(
        app,
        admin.userId,
        calls,
        undefined,
        ask
      );
      const outcomes: { code: string; asked: boolean }[] = [];
      // Each stage twice: as the engine lets the attempt go with the
      // cancel, and as the cancel is written before the engine hears.
      const tries = Array.from({ length: uncancelled.stages }, (_, index) =>
        [false, true].map((leaseKept) => ({ stage: index + 1, leaseKept }))
      ).flat();
      for (const { stage, leaseKept } of tries) {
        // oxlint-disable-next-line no-await-in-loop -- one stage at a time
        const { answered, run } = await cancelledAt(
          app,
          admin.userId,
          calls,
          stage,
          ask,
          undefined,
          leaseKept
        );
        // oxlint-disable-next-line no-await-in-loop -- as above
        const actions = await actionsOf(run);
        outcomes.push({
          code: codeOf(answered),
          asked: actions.includes("workflow.decision.asked"),
        });
      }

      expect({
        uncancelled: codeOf(uncancelled.answered),
        stages: uncancelled.stages > 1,
        outcomes: new Set(outcomes.map((outcome) => JSON.stringify(outcome))),
      }).toStrictEqual({
        uncancelled: "ok",
        stages: true,
        outcomes: new Set([
          JSON.stringify({ code: "execution.stale_attempt", asked: false }),
        ]),
      });
    });

    it("open no decision, and record or tell of none, for a run cancelled as it opens", async () => {
      const admin = await personApi("admin");
      const app = await appWith(admin, {});
      const calls = { steps: { tidy: [] }, all: [] };
      const open = async (attempt: AttemptHost, arm: () => void) => {
        arm();
        return await attempt.openDecision({
          step: "tidy",
          from: `person:${admin.userId}`,
          description: "Approve the invoice",
          timeout: 60_000,
        });
      };
      const uncancelled = await cancelledAt(
        app,
        admin.userId,
        calls,
        undefined,
        open
      );
      const outcomes: { code: string; opened: boolean; kept: boolean }[] = [];
      for (let stage = 1; stage <= uncancelled.stages; stage += 1) {
        // Only the cancel's tombstone: the decision's own write checks it.
        // oxlint-disable-next-line no-await-in-loop -- one stage at a time
        const { answered, run } = await cancelledAt(
          app,
          admin.userId,
          calls,
          stage,
          open,
          undefined,
          true
        );
        // oxlint-disable-next-line no-await-in-loop -- as above
        const events = await allEvents();
        // oxlint-disable-next-line no-await-in-loop -- as above
        const kept = await env.DB.prepare(
          "SELECT count(*) AS kept FROM workflow_decisions WHERE run_id = ?"
        )
          .bind(run)
          .first<number>("kept");
        outcomes.push({
          code: codeOf(answered),
          opened: events.some(
            (event) =>
              event.action === "workflow.decision.opened" &&
              JSON.stringify(event).includes(run)
          ),
          kept: (kept ?? 0) > 0,
        });
      }

      // A cancel the decision's write found opened nothing, recorded
      // nothing and answered stale; one after it found a decision that
      // stands, recorded as opened.
      expect({
        uncancelled: codeOf(uncancelled.answered),
        consistent: outcomes.every(
          ({ code, opened, kept }) =>
            opened === kept && (kept || code === "execution.stale_attempt")
        ),
        refusedBeforeOpening: outcomes.some(({ kept }) => !kept),
      }).toStrictEqual({
        uncancelled: "ok",
        consistent: true,
        refusedBeforeOpening: true,
      });
    });

    it("hand back no attachment and record no read of it, cancelled at any stage", async () => {
      const builder = await personApi("builder");
      const app = await appWith(builder, {});
      const raw = new TextEncoder().encode(mail);
      const id = toHex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", raw))
      );
      const stored = await keepMessage(env, [appIdSchema.parse(app)], id, raw);
      const calls = { steps: { tidy: [] }, all: [] };
      const read = async (attempt: AttemptHost, arm: () => void) => {
        arm();
        return await attempt.readAttachment(stored, 0);
      };
      const uncancelled = await cancelledAt(
        app,
        builder.userId,
        calls,
        undefined,
        read
      );
      const outcomes: { code: string; read: boolean }[] = [];
      for (let stage = 1; stage <= uncancelled.stages; stage += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one stage at a time
        const { answered, run } = await cancelledAt(
          app,
          builder.userId,
          calls,
          stage,
          read
        );
        // oxlint-disable-next-line no-await-in-loop -- as above
        const events = await allEvents();
        outcomes.push({
          code: codeOf(answered),
          read: events.some(
            ({ action, target, detail }) =>
              action === "workflow.email.read" &&
              target?.id === run &&
              detail.bytes !== undefined
          ),
        });
      }

      expect({
        uncancelled: codeOf(uncancelled.answered),
        stages: uncancelled.stages > 0,
        outcomes: new Set(outcomes.map((outcome) => JSON.stringify(outcome))),
      }).toStrictEqual({
        uncancelled: "ok",
        stages: true,
        outcomes: new Set([
          JSON.stringify({ code: "execution.stale_attempt", read: false }),
        ]),
      });
    });

    it("hand back no collection document, cancelled at any stage, the collection's read included", async () => {
      const admin = await personApi("admin");
      const app = await appWith(admin, {});
      const { collectionId, noteId } = await collectionWithNote(admin.api, {
        name: "Handbook",
        access: "everyone",
      });
      await requestGranted(
        idp,
        admin,
        readCollection(
          { type: "app", appId: appIdSchema.parse(app) },
          collectionId
        )
      );
      const calls = { steps: { tidy: ["HANDBOOK"] }, all: ["HANDBOOK"] };
      const read = async (attempt: AttemptHost, arm: () => void) => {
        arm();
        return await attempt.callCollection("HANDBOOK", "getDocument", [
          noteId,
        ]);
      };
      const uncancelled = await cancelledAt(
        app,
        admin.userId,
        calls,
        undefined,
        read
      );
      const { answered: asItStarts } = await cancelledAt(
        app,
        admin.userId,
        calls,
        undefined,
        read,
        cancelledAround("starts")
      );
      const { answered: asItAnswers } = await cancelledAt(
        app,
        admin.userId,
        calls,
        undefined,
        read,
        cancelledAround("answers")
      );

      expect({
        uncancelled: codeOf(uncancelled.answered),
        asItStarts: codeOf(asItStarts),
        asItAnswers: codeOf(asItAnswers),
      }).toStrictEqual({
        uncancelled: "ok",
        asItStarts: "execution.stale_attempt",
        asItAnswers: "execution.stale_attempt",
      });
    });
  }
);

/** The public methods of a class, by its prototype. */
const own = (prototype: object) =>
  Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .toSorted();

describe("the hosts a run's code reaches", () => {
  it("are an attempt's host, whose every method is a fenced call, and the run's, which runs steps only", () => {
    expect({
      attempt: own(AttemptHost.prototype),
      run: own(RunHost.prototype),
    }).toStrictEqual({
      attempt: Object.keys(attemptCallLabels).toSorted(),
      run: ["do", "sleep", "waitForDecision"],
    });
  });
});
