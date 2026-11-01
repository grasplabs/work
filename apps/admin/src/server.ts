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
 * `POST /discord/interactions` is the one route outside Access: Discord
 * posts Grasp's bot's interactions there (src/admin/discord.ts), so it
 * can't carry an Access JWT. It answers only what Discord's signature
 * vouches for, and only Grasp's staff; Access's application has a bypass
 * policy for this path alone.
 *
 * The cron imports newly published releases (src/releases/import.ts),
 * then resumes provisioning that isn't getting anywhere
 * (src/hosting/reconcile.ts);
 * the digest's own cron posts the admin's morning digest to Discord
 * (src/admin/discord-digest.ts), and the watch's reads how Stephen fares
 * at every client every hour
 * (src/clients/watch.ts).
 * `AdminRuns` holds the admin's runs on Workerflow (src/workflow-runs.ts):
 * applying a client's settings now
 * (src/clients/apply.ts), attempts at provisioning a client placed in a
 * hosting destination (src/hosting/workflow.ts), rollouts and the runs
 * that deploy their fleet clients (src/rollout/workflow.ts,
 * src/rollout/fleet-client.ts), and rollbacks (src/rollout/rollback.ts).
 *
 * `/mcp` is the admin's MCP server for Grasp's staff (src/admin/mcp.ts),
 * behind the same Access check.
 */
import { log } from "@grasp-os/shared/log";
import handler from "@tanstack/react-start/server-entry";
import { env as workerEnv, waitUntil } from "cloudflare:workers";

import { withAccess } from "./access.ts";
import type { Staff } from "./access.ts";
import { adminHostRedirect } from "./admin-host.ts";
import { digestCron, sendMorningDigest } from "./admin/discord-digest.ts";
import {
  discordInteraction,
  discordInteractionsPath,
} from "./admin/discord.ts";
import { adminMcp, adminMcpPath } from "./admin/mcp.ts";
import { watchCron, watchStephen } from "./clients/watch.ts";
import { adminDatabase } from "./db/act.ts";
import { errorCode } from "./deploy/errors.ts";
import { reconcileProvisioning } from "./hosting/reconcile.ts";
import { importReleases } from "./releases/import.ts";

export { ChatState } from "@grasp-os/chat/state";
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

export default {
  // Past the Access check, a page may move to the admin's own hostname
  // (src/admin-host.ts), so nothing about it shows to anyone else.
  fetch: async (request: Request, env: Env) => {
    if (new URL(request.url).pathname === discordInteractionsPath) {
      return await discordInteraction(request, env, waitUntil);
    }
    return await withStaff(request, env, () => adminHostRedirect(request, env));
  },
  scheduled: async (controller, env) => {
    if (controller.cron === digestCron) {
      await sendMorningDigest(env, new Date(controller.scheduledTime));
      return;
    }
    if (controller.cron === watchCron) {
      await watchStephen(env, new Date(controller.scheduledTime));
      return;
    }
    // An import that fails never keeps stuck provisioning from resuming:
    // logged by its code, and reconciling runs all the same.
    try {
      await importReleases(env.RELEASES, adminDatabase(env.DB));
    } catch (error) {
      log.error("releases.import_failed", { error: errorCode(error) });
    }
    // After the import: a client waiting for a newer release takes it.
    await reconcileProvisioning(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
