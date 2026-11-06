/**
 * Every organization as the admin's model sees it: for each client whose
 * core answered, its snapshot read as an organization (`adminOrgOf`) and
 * that organization's view on core's own day (`adminViewOf`), from which
 * the overview and the sidebar say where it stands and what needs Grasp.
 * A client whose core didn't answer has no view: nothing is known of it
 * now, so nothing is shown for it but why.
 */
import { adminOrgOf } from "@grasp-os/shared/admin/admin-snapshot-adapter";
import { adminViewOf, byUrgency } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import type { Need } from "@grasp-os/shared/admin/onboarding-admin";

import type { Billing } from "../billing/billing.ts";
import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import type { Channel } from "../db/schema.ts";
import { channelWords } from "../rollout/channel-words.ts";
import { formatDate } from "./words.ts";

/** One organization: the client as the admin reads it, and its view when its core answered. */
export interface Organization {
  admin: ClientAdmin;
  view: AdminView | null;
}

/**
 * What Stripe says needs Grasp: invoices past their due date, in the
 * currency of the first (a company is billed in one).
 */
export const billingNeeds = (billing: Billing): Need[] => {
  if (billing.state !== "read") {
    return [];
  }
  const { overdue } = billing.account;
  const [amount] = overdue.amount;
  if (overdue.count === 0 || amount === undefined || overdue.since === null) {
    return [];
  }
  return [
    {
      kind: "overdue",
      count: overdue.count,
      amount: amount.amount,
      currency: amount.currency,
      since: overdue.since,
    },
  ];
};

/**
 * The view of one answered client, counted up to the day its core
 * answered on, with what its billing says needs Grasp among its needs.
 */
const viewOf = (admin: ClientAdmin): AdminView | null => {
  if (admin.state !== "answered") {
    return null;
  }
  const { snapshot, client } = admin;
  const { org, state } = adminOrgOf(snapshot, {
    id: client.id,
    name: client.name,
  });
  // Core's clock is what the snapshot's days count to, not the admin's.
  const view = adminViewOf(org, state, snapshot.now.slice(0, 10));
  const billed = billingNeeds(admin.billing);
  return billed.length === 0
    ? view
    : { ...view, needs: [...view.needs, ...billed].toSorted(byUrgency) };
};

/** One client, with its view when its core answered. */
export const organizationOf = (admin: ClientAdmin): Organization => ({
  admin,
  view: viewOf(admin),
});

/** Every client, in the loader's order, each with its view when its core answered. */
export const organizationsOf = (
  admins: readonly ClientAdmin[]
): Organization[] => admins.map(organizationOf);

/** Why a client's core isn't read now, in words: not deployed yet, or not answering. */
export const unreadWords = (
  admin: Extract<ClientAdmin, { state: "unreachable" }>
): string => (admin.error === "not_deployed" ? "not deployed" : "unreachable");

/** Why a core didn't answer, as the rest of a sentence. */
const whyWords: Record<
  Exclude<
    Extract<ClientAdmin, { state: "unreachable" }>["error"],
    "not_deployed"
  >,
  string
> = {
  no_route: "the router has no route to it",
  unconfigured: "the admin can’t sign or route a request for it",
  not_served: "its release is older than the admin",
  refused: "it refused the admin’s request",
  core_error: "it answered with an error",
  invalid_answer: "what it answered can’t be read",
  timeout: "it didn’t answer in time",
  no_answer: "the request to it failed",
};

/** Why a core wasn't read, as the rest of a sentence. */
export const whyUnread = (
  error: Extract<ClientAdmin, { state: "unreachable" }>["error"]
): string => (error === "not_deployed" ? "it isn’t deployed" : whyWords[error]);

/**
 * Why a client's core isn't read now, in a sentence or two: not deployed
 * yet, or not answering and why, with when it last did.
 */
export const unreadWhy = (
  admin: Extract<ClientAdmin, { state: "unreachable" }>
): string => {
  if (admin.error === "not_deployed") {
    return "Its Grasp isn’t deployed yet, so there is nothing of it to read.";
  }
  const since =
    admin.lastAnsweredAt === null
      ? "It has never answered."
      : `It last answered on ${formatDate(admin.lastAnsweredAt)}.`;
  return `Its Grasp can’t be read now: ${whyWords[admin.error]}. ${since}`;
};

/**
 * How many releases a live client may be behind the one it should run
 * before it needs Grasp: a deploy or two still on their way is normal.
 */
export const releasesBehindAllowed = 2;

/**
 * What a live client's own platform needs of Grasp, from what the admin
 * recorded, its core answering or not: the reconciler can't act on its
 * channel, its deploy failed and nobody retried it, or it fell behind its
 * release. Each is acted on from its Setup, where its deploy is retried.
 * They come before anything its core says: Grasp fixes nothing there
 * while it can't deploy.
 */
export type RolloutNeed =
  | { kind: "channel_stopped"; channel: Channel; error: string }
  | { kind: "deploy_failed"; releaseId: string; error: string | null }
  | { kind: "behind"; releases: number };

/** What client `client`'s rollout needs of Grasp (`RolloutNeed`). */
export const rolloutNeeds = (client: GridRow): RolloutNeed[] => {
  if (client.status !== "active") {
    return [];
  }
  const { failed, behind, channelStopped } = client.rollout;
  const needs: RolloutNeed[] = [];
  if (channelStopped !== null) {
    needs.push({
      kind: "channel_stopped",
      channel: client.channel,
      error: channelStopped,
    });
  }
  if (failed !== null) {
    needs.push({ kind: "deploy_failed", ...failed });
  }
  if (behind > releasesBehindAllowed) {
    needs.push({ kind: "behind", releases: behind });
  }
  return needs;
};

/** A rollout need, said in a sentence. */
export const rolloutNeedLine = (need: RolloutNeed): string => {
  if (need.kind === "behind") {
    return `It runs ${need.releases} releases behind the one it should. Look at its Setup.`;
  }
  if (need.kind === "channel_stopped") {
    return `Nothing deploys on its channel, ${channelWords[need.channel]}: the reconciler can't act on it (${need.error}).`;
  }
  const why = need.error === null ? "" : ` (${need.error})`;
  return `Its deploy of ${need.releaseId} failed${why}. Retry it on its Setup once what stopped it is fixed.`;
};
