/**
 * The admin's Worker entry: TanStack Start's handler, behind the Access
 * check (src/access.ts). Every request the Worker sees, pages and server
 * functions alike, passes the check first; server code reads the verified
 * staff member from the request context. The built client files (JS, CSS)
 * are served before the Worker, behind Access at the edge only: they hold
 * nothing but the open-source app's code.
 *
 * The admin can have a hostname of its own (src/admin-host.ts). Its pages
 * are served from the root.
 *
 * Newly published releases are imported (src/releases/import.ts), each
 * taken to Edge as it's saved (src/rollout/channels.ts), as soon as R2
 * says a manifest was written, through the admin's queue, and by the cron
 * every minute besides, one import at a time. Every fifth minute the cron
 * also deletes the bundles of releases never promoted past Edge after 14
 * days (src/releases/retention.ts), under the import's lease, then
 * deploys each client whose Workers run something other than its target
 * (src/rollout/reconciler.ts), then resumes provisioning that isn't
 * getting anywhere
 * (src/hosting/reconcile.ts). Each minute's run ends by telling staff of
 * what failed or recovered (src/alerts/alert.ts); the watch's own cron reads how Stephen fares
 * at every client every hour (src/clients/watch.ts).
 * `AdminRuns` holds the admin's runs on Workerflow (src/workflow-runs.ts):
 * applying a client's settings now
 * (src/clients/apply.ts), attempts at provisioning a client placed in a
 * hosting destination (src/hosting/workflow.ts), and clients' deploys
 * (src/rollout/deploy.ts).
 *
 * `/mcp` is the admin's MCP server for Grasp's staff (src/admin/mcp.ts),
 * behind the same Access check.
 */
import "@tanstack/react-start/server-only";
import { log } from "@grasp-os/shared/log";
import handler from "@tanstack/react-start/server-entry";
import { env as workerEnv } from "cloudflare:workers";

import { withAccess } from "./access.ts";
import type { Staff } from "./access.ts";
import { adminHostRedirect } from "./admin-host.ts";
import { adminMcp, adminMcpPath } from "./admin/mcp.ts";
import { deliverAlerts } from "./alerts/alert.ts";
import { watchCron, watchStephen } from "./clients/watch.ts";
import { adminDatabase } from "./db/act.ts";
import { withLease } from "./db/lease.ts";
import { errorCode } from "./deploy/errors.ts";
import { reconcileProvisioning } from "./hosting/reconcile.ts";
import { importReleases } from "./releases/import.ts";
import type { ImportResult } from "./releases/import.ts";
import { deleteExpiredBundles } from "./releases/retention.ts";
import { reconcile } from "./rollout/reconciler.ts";

export { AdminRuns } from "./run-object.ts";

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { staff: Staff } };
  }
}

const withStaff = withAccess(async (request, staff) =>
  new URL(request.url).pathname === adminMcpPath
    ? await adminMcp(request, staff, workerEnv)
    : await handler.fetch(request, { context: { staff } })
);

/** Every this many minutes, the admin's cron runs the rest of its tick after the import. */
const TICK_MINUTES = 5;

/** What an import that didn't run did. */
const nothingImported: ImportResult = {
  imported: [],
  failed: [],
  caughtUp: false,
};

/**
 * The import, one run at a time (the `releases` lease, src/db/lease.ts):
 * nothing, at once, while another runs. With `retentionAt` (the tick's),
 * retention runs after it under the same lease, once the import read
 * every release published, so it never deletes a blob an import running
 * beside it relies on. A failure of either is logged by its code.
 */
const importNow = async (
  env: Env,
  retentionAt?: Date
): Promise<ImportResult> => {
  const db = adminDatabase(env.DB);
  try {
    const result = await withLease(db, "releases", async () => {
      const done = await importReleases(env.RELEASES, db);
      // Bundles of releases never promoted past Edge go after 14 days:
      // only once each published release's blobs are on record and kept.
      if (retentionAt !== undefined && done.caughtUp) {
        try {
          await deleteExpiredBundles(db, env.RELEASES, retentionAt);
        } catch (error) {
          log.error("releases.retention_failed", { error: errorCode(error) });
        }
      }
      return done;
    });
    return result ?? nothingImported;
  } catch (error) {
    log.error("releases.import_failed", { error: errorCode(error) });
    return nothingImported;
  }
};

/**
 * Each client to its target, Edge's new release among them: on the tick,
 * and at once when an import took a release to Edge, as a staff member's
 * promotion does (src/rollout/functions.ts). The reconciler acts only
 * while it holds its lease, so runs that overlap are safe.
 */
const reconcileNow = async (env: Env): Promise<void> => {
  try {
    await reconcile(env);
  } catch (error) {
    log.error("reconcile.failed", { error: errorCode(error) });
  }
};

export default {
  // Past the Access check, a page may move to the admin's own hostname
  // (src/admin-host.ts), so nothing about it shows to anyone else.
  fetch: async (request: Request, env: Env) =>
    await withStaff(request, env, () => adminHostRedirect(request, env)),
  scheduled: async (controller, env) => {
    const at = new Date(controller.scheduledTime);
    if (controller.cron === watchCron) {
      await watchStephen(env, at);
      return;
    }
    // Every minute, the import; every fifth, retention with it, then the
    // rest of the tick. An import that fails, or that another run holds,
    // never keeps stuck provisioning from resuming: the rest runs all the
    // same.
    const tick = at.getUTCMinutes() % TICK_MINUTES === 0;
    const { imported } = await importNow(env, tick ? at : undefined);
    if (tick || imported.length > 0) {
      await reconcileNow(env);
    }
    if (tick) {
      // After the import: a client waiting for a newer release takes it.
      await reconcileProvisioning(env, at);
    }
    // Last: what failed or recovered in this run, or in a deploy's run
    // since the last, is told now (src/alerts/alert.ts).
    await deliverAlerts(env);
  },
  // R2's event notifications of a manifest written under releases/
  // (apps/admin/wrangler.jsonc): each batch, whatever it holds, runs the
  // import once, which reads the bucket, never the message, and is
  // acknowledged, as the import logs its own failures and the cron tries
  // again; nothing while the cron's import runs, which the next minute's
  // follows.
  queue: async (_batch, env) => {
    const { imported } = await importNow(env);
    if (imported.length > 0) {
      await reconcileNow(env);
    }
  },
} satisfies ExportedHandler<Env>;
