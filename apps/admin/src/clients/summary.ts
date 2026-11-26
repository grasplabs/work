/**
 * Every client's summary, as the admin's sidebar and Inbox show it: what
 * each core answers at `adminSummaryPath` (core's src/admin-summary.ts),
 * counts and dates only, beside what its Stripe customer says is overdue.
 * Asked as the grid asks for the onboarding summary (onboarding.ts):
 * through the router's route with the router secret, signed with the key
 * both derive from the client's auth secret, here for the summary's
 * purpose alone. Unlike the admin snapshot (admin.ts) it names nobody, so
 * no staff member is named and no core audits the read: the frame can
 * read it on every load.
 *
 * Every client the admin knows but those offboarded is in the answer, read
 * a few at a time (src/live-reads.ts), each within the grid's deadline
 * from when its own read starts, as the snapshots are read, so one slow or
 * failing core never holds up the others. One whose core doesn't answer is
 * unreachable; one not deployed yet, not deployed. Nothing of a summary is
 * kept: the admin holds no client data.
 */
import "@tanstack/react-start/server-only";
import {
  adminSummaryPath,
  adminSummaryPurpose,
  adminSummarySchema,
} from "@grasp-os/shared/admin-summary";
import type { AdminSummary } from "@grasp-os/shared/admin-summary";
import { log } from "@grasp-os/shared/log";

import { billingOf, stripeKey, stripeLinks } from "../billing/billing.ts";
import type { Billing } from "../billing/billing.ts";
import { adminDatabase } from "../db/act.ts";
import { deploySecrets, ifStored } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { eachLimited, within } from "../live-reads.ts";
import { defaultAdminReadOptions } from "./admin.ts";
import type { AdminReadOptions } from "./admin.ts";
import { signedCoreReport } from "./core-report.ts";
import { clientGrid, routeOf } from "./grid.ts";
import type { GridRow } from "./grid.ts";

/** One client's summary, with its billing; or why there is none now. */
export type ClientSummary =
  | {
      client: GridRow;
      state: "answered";
      summary: AdminSummary;
      /** What it pays and whether it is paid, as Stripe says, or why that isn't read. */
      billing: Billing;
    }
  | { client: GridRow; state: "not_deployed" | "unreachable" };

/**
 * Client `row`'s summary, asked of its core within `timeoutMs` from when
 * this is called; null when it can't be asked or doesn't answer with one.
 * Never throws.
 */
const summaryOf = async (
  env: Env,
  secrets: DeploySecrets | null,
  row: GridRow,
  timeoutMs: number
): Promise<AdminSummary | null> =>
  await within(
    timeoutMs,
    async (signal) => {
      if (secrets === null) {
        return null;
      }
      const route = await routeOf(
        env.ROUTER_HOSTS,
        secrets.routerKey,
        row.id,
        row.hostname,
        env.DISPATCHER
      );
      if (typeof route === "string") {
        return null;
      }
      try {
        return await signedCoreReport(
          {
            core: route.core,
            routerSecret: route.secret,
            authSecret: await clientAuthSecret(
              secrets,
              row.id,
              route.generation
            ),
            signal,
          },
          {
            path: adminSummaryPath,
            purpose: adminSummaryPurpose,
            schema: adminSummarySchema,
          }
        );
      } catch (error) {
        log.warn("admin.summary_unread", {
          clientId: row.id,
          error: errorCode(error),
        });
        return null;
      }
    },
    null
  );

/**
 * Every client the admin knows but those offboarded, each with its
 * summary and billing, or why there is none now. Never throws for a
 * client; every one is in the answer, in the grid's order.
 */
export const clientSummaries = async (
  env: Env,
  options: AdminReadOptions = defaultAdminReadOptions
): Promise<ClientSummary[]> => {
  const db = adminDatabase(env.DB);
  const grid = await clientGrid(env);
  const known = grid.filter(({ status }) => status !== "offboarded");
  const [secrets, key, links] = await Promise.all([
    ifStored(async (): Promise<DeploySecrets> => await deploySecrets(env)),
    stripeKey(env),
    stripeLinks(db),
  ]);
  // Each client's deadline starts inside its turn, not here.
  return await eachLimited(
    known,
    options.concurrency,
    async (client): Promise<ClientSummary> => {
      if (client.status !== "active") {
        return { client, state: "not_deployed" };
      }
      const [summary, billing] = await Promise.all([
        summaryOf(env, secrets, client, options.timeoutMs),
        billingOf({
          key,
          customerId: links.get(client.id) ?? null,
          clientId: client.id,
          timeoutMs: options.timeoutMs,
        }),
      ]);
      return summary === null
        ? { client, state: "unreachable" }
        : { client, state: "answered", summary, billing };
    }
  );
};
