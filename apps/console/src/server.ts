/**
 * The console's Worker entry: TanStack Start's handler, behind the Access
 * check (src/access.ts). Every request the Worker sees, pages and server
 * functions alike, passes the check first; server code reads the verified
 * staff member from the request context. The built client files (JS, CSS)
 * are served before the Worker, behind Access at the edge only: they hold
 * nothing but the open-source app's code.
 *
 * Grasp's admin can have a hostname of its own (src/admin-host.ts). The
 * console's Releases and Rollouts pages moved under its Platform, and
 * their old addresses redirect there (src/moved-pages.ts).
 *
 * `POST /discord/interactions` is the one route outside Access: Discord
 * posts Grasp's bot's interactions there (src/admin/discord.ts), so it
 * can't carry an Access JWT. It answers only what Discord's signature
 * vouches for, and only Grasp's staff; Access's application has a bypass
 * policy for this path alone.
 *
 * The cron imports newly published releases (src/releases/import.ts);
 * the digest's own cron posts the admin's morning digest to Discord
 * (src/admin/discord-digest.ts).
 * `ProvisionClient` is the Workflow that onboards a client
 * (src/provision/workflow.ts), `Rollout` the one that rolls a release
 * out to clients (src/rollout/workflow.ts), `RolloutClient` deploys one
 * fleet client of a rollout, `RollbackClient` rolls a
 * client back from one, and `ApplyClient` applies a client's settings
 * now (src/clients/apply.ts). `ProvisionPlacedClient` provisions a client
 * placed in a hosting destination (src/hosting/workflow.ts).
 *
 * `/mcp` is the admin's MCP server for Grasp's staff (src/admin/mcp.ts),
 * behind the same Access check.
 */
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
import { consoleDatabase } from "./db/act.ts";
import { movedPageRedirect } from "./moved-pages.ts";
import { importReleases } from "./releases/import.ts";

export { IntegrationBuild } from "./builds/workflow.ts";
export { ApplyClient } from "./clients/apply.ts";
export { ProvisionPlacedClient } from "./hosting/workflow.ts";
export { ProvisionClient } from "./provision/workflow.ts";
export { RollbackClient } from "./rollout/rollback.ts";
export { RolloutClient } from "./rollout/fleet-client.ts";
export { Rollout } from "./rollout/workflow.ts";

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
  // Past the Access check, a page may move to or from the admin's own
  // hostname (src/admin-host.ts), or from where it was to the admin
  // (src/moved-pages.ts), so nothing about it shows to anyone else.
  fetch: async (request: Request, env: Env) => {
    if (new URL(request.url).pathname === discordInteractionsPath) {
      return await discordInteraction(request, env, waitUntil);
    }
    return await withStaff(
      request,
      env,
      () => movedPageRedirect(request) ?? adminHostRedirect(request, env)
    );
  },
  scheduled: async (controller, env) => {
    if (controller.cron === digestCron) {
      await sendMorningDigest(env, new Date(controller.scheduledTime));
      return;
    }
    await importReleases(env.RELEASES, consoleDatabase(env.DB));
  },
} satisfies ExportedHandler<Env>;
