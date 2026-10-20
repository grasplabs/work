import { toHex } from "@grasp-os/shared/encoding";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { AttemptHost } from "../src/workflows/attempt-host.ts";
import type { Settled } from "../src/workflows/code.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks } from "../src/workflows/host.ts";
import { keepMessage } from "../src/workflows/kept-email.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { engineOfTest } from "./run-host.ts";
import { signedInApi } from "./sign-in.ts";

// A run's reads of a kept message's attachments where the outside systems
// fail: R2 (a fetch that fails once) and the database the audit record is
// written to. On the host a run's code calls, with an engine of the
// test's own that runs each step once, as the platform's does; the email
// tests read attachments in real runs.

const idp = mockIdp();

/** A message from Ben with one PDF attachment, `%PDF-`. */
const mail = [
  "From: Ben <ben@acme.test>",
  "To: scans@grasp.test",
  "Subject: Scan",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Attached.",
  "--b",
  'Content-Type: application/pdf; name="scan.pdf"',
  'Content-Disposition: attachment; filename="scan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0=",
  "--b--",
  "",
].join("\r\n");

const { step, leaseOf } = engineOfTest();

const hooks: HostHooks = {
  stepFailed: () => {},
  busyRefusals: new Map(),
  leaseOf,
  tampered: () => {},
  waiting: async () => {
    await Promise.resolve();
  },
  callFunction: () => {
    throw new Error("A read calls no App function");
  },
  modelBinding: () => {
    throw new Error("No model step here");
  },
};

/**
 * A new App, a message kept for it, and a run of it acting for a person
 * who is there, on `changes` to the env.
 */
const runReading = async (changes: Partial<Env> = {}) => {
  const builder = await signedInApi(idp, "builder");
  const { userId } = builder;
  const created = await builder.api.apps.create({ name: "Scans" });
  const app = appIdSchema.parse(created.id);
  const raw = new TextEncoder().encode(mail);
  const id = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  const stored = await keepMessage(env, [app], id, raw);
  const runId = runIdSchema.parse(crypto.randomUUID());
  // Its row: a read is handed on only while the run goes on.
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'scans', 1, ?, 'running', ?)"
  )
    .bind(runId, app, userId, Date.now())
    .run();
  const host = new RunHost(
    { ...env, ...changes },
    step,
    {
      app,
      workflow: workflowIdSchema.parse("scans"),
      version: 1,
      runId,
      shareSubject: userId,
      authority: authoritySchema.parse({
        subject: { type: "app", appId: app },
        onBehalfOf: userId,
        mode: "workflow",
        appVersion: 1,
      }),
      connections: {},
      collections: {},
      calls: { steps: null, all: [] },
    },
    hooks
  );
  return { host, stored, runId };
};

/**
 * Runs `reads` as the function of one step, with the host of its attempt,
 * and returns what it read.
 */
const inStep = async (
  host: RunHost,
  reads: (attempt: AttemptHost) => Promise<unknown>
): Promise<unknown> => {
  const done = await host.do(
    "read",
    { description: "Read" },
    async (attempt) => ({ ok: true, value: await reads(attempt) })
  );
  if (!done.ok) {
    throw new Error(`The step failed: ${done.error.message}`);
  }
  return done.value;
};

/** How a read ended: its content as text, or its error's code. */
const outcome = (read: Settled<Uint8Array>): string =>
  read.ok
    ? new TextDecoder().decode(read.value)
    : (read.error.code ?? read.error.message);

/** The audit log's reads of kept messages by run `runId`, their detail. */
const auditedReads = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.email.read" && target?.id === runId
    )
    .map(({ detail }) => detail);
};

describe("reads of a kept message's attachments", () => {
  it("fetch the message again in the same step after a fetch that failed", async () => {
    let failures = 1;
    const files = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "get" && failures > 0) {
          return async () => {
            failures -= 1;
            return await Promise.reject(new Error("R2 unavailable"));
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const { host, stored } = await runReading({ FILES: files });

    const read = await inStep(host, async (attempt) => [
      outcome(await attempt.readAttachment(stored, 0)),
      outcome(await attempt.readAttachment(stored, 0)),
    ]);

    expect(read).toStrictEqual(["internal.unexpected", "%PDF-"]);
  });

  it("fail as one to try again, not as their refusal, when the refusal can't be recorded", async () => {
    const { host, runId } = await runReading({
      DB: new Proxy(env.DB, {
        get: (target, property) => {
          if (property === "batch") {
            return async () =>
              await Promise.reject(new Error("D1 unavailable"));
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      }),
    });

    const read = await inStep(host, async (attempt) =>
      outcome(await attempt.readAttachment("2026-09-29/../x", 0))
    );

    expect({ read, audited: await auditedReads(runId) }).toStrictEqual({
      read: "internal.unexpected",
      audited: [],
    });
  });

  it("are refused and recorded for a message that isn't kept, and once their attempt is over, audited as stale once", async () => {
    const { host, runId } = await runReading();
    let kept: AttemptHost | undefined;

    const unkept = await inStep(host, async (attempt) => {
      kept = attempt;
      return outcome(await attempt.readAttachment(null, 0));
    });
    const late: string[] = [];
    for (let tries = 0; tries < 3; tries += 1) {
      late.push(
        kept === undefined
          ? "no attempt"
          : // oxlint-disable-next-line no-await-in-loop -- one read at a time
            outcome(await kept.readAttachment(null, 0))
      );
    }
    const events = await allEvents();

    expect({
      unkept,
      late,
      audited: await auditedReads(runId),
      refused: events
        .filter(
          ({ action, target }) =>
            action === "workflow.call.refused" && target?.id === runId
        )
        .map(({ detail }) => detail),
    }).toMatchObject({
      unkept: "workflow.attachment_not_found",
      late: [
        "execution.stale_attempt",
        "execution.stale_attempt",
        "execution.stale_attempt",
      ],
      audited: [
        {
          step: "read",
          message: null,
          errorCode: "workflow.attachment_not_found",
        },
      ],
      // A loop of late reads leaves one record, however long it runs.
      refused: [
        {
          step: "read",
          call: "attachment",
          errorCode: "execution.stale_attempt",
        },
      ],
    });
  });
});
