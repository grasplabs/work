import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { auditEvents } from "../src/db/schema.ts";
import { recordUnstarted } from "../src/hosting/operation.ts";
import { provisioningProgress } from "../src/hosting/progress.ts";
import { operationErrorWords } from "../src/hosting/words.ts";
import { provisionPlacedClient } from "../src/hosting/workflow.ts";
import { getProvisioning } from "../src/provision/queries.ts";
import { takeAttempt } from "../src/runners.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import {
  token,
  cloudflare,
  importRelease,
  setUp,
  operationOf,
  isMigration,
  readMigrations,
  provisioned,
  once,
  heldAfter,
  attemptEnded,
} from "./client-provision-harness.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { graspAccount } from "./grasp-account.ts";
import { db, destination, placedClient, staff } from "./hosting.ts";
import {
  deliverAlarm,
  holdBatchOf,
  holdFirstBatchOf,
  journalOf,
  startsOf,
  timeOutAttempt,
} from "./runs.ts";
import type { LostWrite } from "./runs.ts";
import {
  emptyStoreSecret,
  setStoreSecret,
  useStoreSecrets,
} from "./secrets-store.ts";

// Here: the operation run as a workflow, its attempts stopping, dying or
// timing out; the rest in the other client-provision-*.test.ts files.

mockCloudflareApi(token, cloudflare);

const isD1Create = (call: ApiCall): boolean =>
  call.method === "POST" && call.path.endsWith("/d1/database");

describe("provisioning a placed client", () => {
  useStoreSecrets({ deployer: token });

  it("runs as a workflow, and starting it again resumes the one operation", async () => {
    const manifest = await importRelease();
    const account = graspAccount(cloudflare);
    const destinationId = await destination({ accountId: account.id });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    // The first attempt is refused connect's upload, and stops.
    cloudflare.failNext(
      (call) => call.method === "PUT" && call.path.endsWith("-connect"),
      400
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      await attemptEnded(attempts.started[0], "errored");
    } finally {
      errors.mockRestore();
    }
    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "failed",
      step: "migrations",
      error: "cloudflare_400_10000",
    });

    // Started again, a new attempt resumes it.
    await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
    await attemptEnded(attempts.started[1], "complete");
    await expect(provisioned(account, clientId)).resolves.toMatchObject(
      once(clientId)
    );
  });

  it("stops an attempt at once, unretried, when Cloudflare answers a database id no path can hold, and sends nothing to it", async () => {
    const manifest = await importRelease();
    const account = graspAccount(cloudflare);
    const destinationId = await destination({ accountId: account.id });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The first attempt asks for a database and is refused; the second
      // finds it by its name, answered with `..` for its id.
      cloudflare.failNext(isD1Create, 400);
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      await attemptEnded(attempts.started[0], "errored");
      const asked = cloudflare.calls.find(isD1Create);
      const { name } = z.object({ name: z.string() }).parse(asked?.body);
      account.d1.push({ uuid: "..", name, jurisdiction: "eu" });

      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      await attemptEnded(attempts.started[1], "errored");
    } finally {
      errors.mockRestore();
    }
    const [, attempt] = attempts.started;
    const journal = await journalOf(
      adminWorkflows.provisionPlacedClient,
      attempt ?? ""
    );

    expect({
      operation: await operationOf(clientId),
      provision: journal.steps.map(({ name: step, attempt: tried }) => ({
        step,
        tried,
      })),
      sent: cloudflare.calls.filter(({ path }) =>
        path.includes("/d1/database/")
      ),
    }).toMatchObject({
      operation: { status: "failed", error: "api_path_refused" },
      provision: [{ step: "provision", tried: 1 }],
      sent: [],
    });
  });

  it("records why an attempt stopped before its operation could run, a secret missing from Secrets Store by name, for Setup to say, and resumes once it's back", async () => {
    const manifest = await importRelease();
    const account = graspAccount(cloudflare);
    const destinationId = await destination({ accountId: account.id });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    await emptyStoreSecret(env.DEPLOYER_API_TOKEN, "DEPLOYER_API_TOKEN");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      await attemptEnded(attempts.started[0], "errored");
    } finally {
      errors.mockRestore();
    }

    const code = "store_secret_missing: DEPLOYER_API_TOKEN";
    const view = await getProvisioning(env, clientId);
    const failed = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.fail")
        )
      );
    expect({
      operation: await operationOf(clientId),
      stopped: view?.stopped,
      phase: view?.phase,
      audited: failed.map(({ detail }): unknown => JSON.parse(detail ?? "{}")),
      calls: account.d1.length,
    }).toMatchObject({
      operation: { status: "failed", step: null, error: code },
      stopped: { step: "validated", error: code },
      phase: "failed",
      audited: [{ step: "validated", error: code }],
      calls: 0,
    });
    expect(operationErrorWords(code)).toContain(
      "Secrets Store has no DEPLOYER_API_TOKEN"
    );

    // Back in the store, a new attempt resumes it.
    await setStoreSecret(env.DEPLOYER_API_TOKEN, "DEPLOYER_API_TOKEN", token);
    await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
    await attemptEnded(attempts.started[1], "complete");
    await expect(operationOf(clientId)).resolves.toMatchObject({
      status: "done",
      error: null,
    });
  });

  it("records a failure before the operation ran as that attempt alone: an old attempt's never lands over the retry that took the client over", async () => {
    const manifest = await importRelease();
    const { clientId, held } = await setUp(manifest);
    const attemptKey = `${held.runId}-provision`;
    const old = { ...held, attempt: 1, attemptKey };
    const retry = { ...held, attempt: 2, attemptKey };
    await takeAttempt(db, old);
    // The old attempt timed out, and its retry took the client.
    await takeAttempt(db, retry);
    const code = "store_secret_missing: ROUTER_KEY";

    await recordUnstarted(db, old, code);
    const afterOld = await operationOf(clientId);
    await recordUnstarted(db, retry, code);
    const afterRetry = await operationOf(clientId);
    const failed = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "provision.fail")
        )
      );

    expect({
      afterOld: [afterOld?.status, afterOld?.error],
      afterRetry: [afterRetry?.status, afterRetry?.error],
      audited: failed.length,
    }).toStrictEqual({
      afterOld: ["running", null],
      afterRetry: ["failed", code],
      audited: 1,
    });
  });

  it("migrates a client once when its attempt times out mid-migration and its retry runs, saying on Setup where the lost attempt stopped", async () => {
    const manifest = await importRelease();
    const account = graspAccount(cloudflare);
    const destinationId = await destination({ accountId: account.id });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    // Each attempt is held once it read which migrations a database still
    // needs: the first times out there, and its retry starts.
    const first = heldAfter(readMigrations);
    const retry = heldAfter(readMigrations);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Both released however the checks go: a held caller left behind
    // would block the run's object for the rest of the file.
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [timingOut] = attempts.started;
      if (timingOut === undefined) {
        throw new Error("No attempt was started");
      }
      await first.read();
      const { retried } = await timeOutAttempt(
        adminWorkflows.provisionPlacedClient,
        timingOut
      );
      await retry.read();
      const whileRetrying = await provisioningProgress(env, clientId);
      // Both read the same migrations as still needed. The one that timed
      // out goes on first, while its retry still holds the client.
      first.release();
      await vi.waitFor(() => {
        const stopped = errors.mock.calls.some((logged) =>
          JSON.stringify(logged).includes("runner_replaced")
        );
        if (!stopped) {
          throw new Error("The attempt that timed out hasn't stopped yet");
        }
      });
      retry.release();
      await retried;
      await attemptEnded(timingOut, "complete");

      const applies = cloudflare.calls.filter(
        (call) =>
          call.path.endsWith("/query") &&
          JSON.stringify(call.body).includes("INSERT INTO d1_migrations")
      );
      expect({
        applies: applies.length,
        provisioned: await provisioned(account, clientId),
        // What Setup says while it's tried again: where the lost one stopped.
        noticeNamesStep: whileRetrying?.notice?.startsWith(
          "A try stopped in its migrations step without recording why"
        ),
      }).toMatchObject({
        applies: 3,
        provisioned: once(clientId),
        noticeNamesStep: true,
      });
    } finally {
      first.release();
      retry.release();
      errors.mockRestore();
    }
  });

  it("reports a provision done when its attempt loses the step's result after the operation completed", async () => {
    const manifest = await importRelease();
    const account = graspAccount(cloudflare);
    const destinationId = await destination({ accountId: account.id });
    const { clientId } = await placedClient(destinationId);
    let held: LostWrite | undefined;
    // Held once the operation is done: its last write, which also gave the
    // client's claim back.
    using attempts = startsOf(
      adminWorkflows.provisionPlacedClient,
      async (stub) => {
        held = await holdBatchOf(stub, async (database) => {
          const status = await database
            .prepare("SELECT status FROM client_provisions WHERE client_id = ?")
            .bind(clientId)
            .first<string>("status");
          return status === "done";
        });
      }
    );
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [finished] = attempts.started;
      if (finished === undefined || held === undefined) {
        throw new Error("No attempt was started");
      }
      await held.committed;
      // The activation is lost before the step's result is kept: the step
      // runs again, finds the operation done, and the run succeeds.
      await deliverAlarm(adminWorkflows.provisionPlacedClient, finished);
      await attemptEnded(finished, "complete");

      await expect(provisioned(account, clientId)).resolves.toMatchObject(
        once(clientId)
      );
    } finally {
      held?.lose();
    }
  });

  it("sends no migration again from an attempt that timed out while it waited out a 429", async () => {
    const manifest = await importRelease();
    const account = graspAccount(cloudflare);
    const destinationId = await destination({ accountId: account.id });
    const { clientId } = await placedClient(destinationId);
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);
    // The first attempt's first migration is refused with a 429, and the
    // attempt is held as it gets it back: its step times out meanwhile,
    // and the retry migrates the client.
    cloudflare.failNext(isMigration, { retryAfter: "0" });
    const refused = heldAfter(isMigration);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [timingOut] = attempts.started;
      if (timingOut === undefined) {
        throw new Error("No attempt was started");
      }
      await refused.read();
      const { retried } = await timeOutAttempt(
        adminWorkflows.provisionPlacedClient,
        timingOut
      );
      await retried;
      await attemptEnded(timingOut, "complete");
      // The attempt that timed out waits out the 429, and would send the
      // migration again.
      refused.release();
      await vi.waitFor(() => {
        const stopped = errors.mock.calls.some((logged) =>
          JSON.stringify(logged).includes("runner_replaced")
        );
        if (!stopped) {
          throw new Error("The attempt that timed out hasn't stopped yet");
        }
      });

      expect({
        // The refused one, then the retry's three.
        sent: cloudflare.calls.filter(isMigration).length,
        provisioned: await provisioned(account, clientId),
      }).toMatchObject({ sent: 4, provisioned: once(clientId) });
    } finally {
      refused.release();
      errors.mockRestore();
    }
  });

  it("provisions a client once when its attempt loses its step's result after the step's first write", async () => {
    const manifest = await importRelease();
    const account = graspAccount(cloudflare);
    const destinationId = await destination({ accountId: account.id });
    const { clientId } = await placedClient(destinationId);
    let held: LostWrite | undefined;
    using attempts = startsOf(
      adminWorkflows.provisionPlacedClient,
      async (stub) => {
        held = await holdFirstBatchOf(stub);
      }
    );

    try {
      await provisionPlacedClient(env, staff, clientId, manifest.releaseId);
      const [lostOne] = attempts.started;
      if (lostOne === undefined || held === undefined) {
        throw new Error("No attempt was started");
      }
      // The step wrote, and its activation is lost before it hears back: a
      // duplicate delivery takes the attempt over, and the step runs again,
      // resuming the operation.
      await held.committed;
      await deliverAlarm(adminWorkflows.provisionPlacedClient, lostOne);
      await attemptEnded(lostOne, "complete");

      const journal = await journalOf(
        adminWorkflows.provisionPlacedClient,
        lostOne
      );
      expect({
        provision: journal.steps.map(({ name, state, attempt: tried }) => ({
          name,
          state,
          tried,
        })),
        provisioned: await provisioned(account, clientId),
      }).toMatchObject({
        provision: [{ name: "provision", state: "succeeded", tried: 2 }],
        provisioned: once(clientId),
      });
    } finally {
      held?.lose();
    }
  });

  // Its later releases and rollbacks (spec 40.3, 40.4): the same
  // operation, run again for the release, onto the same stable scripts
  // and the client's own resources. How they can fail, each tried below:
  // - a release of a client not live yet, or over an operation still
  //   running another release, or two at once;
  // - a script taken back past a Durable Object migration it ran, by a
  //   rollback or a release to an older one, refused before any upload;
  // - a rollback with nothing before to go back to;
  // - a release that stops part way, resumed: nothing made twice, and its
  //   hostname not moved until it passes its probe;
  // - a release whose code, live on the stable scripts, fails its probe:
  //   rolled back on its own, audited, and staff told, also when the
  //   rollback doesn't finish.
});
