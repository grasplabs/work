/**
 * Every organization as the admin's model sees it: for each client whose
 * core answered, its snapshot read as an organization (`adminOrgOf`) and
 * that organization's view on core's own day (`adminViewOf`), from which
 * the overview and the sidebar say where it stands and what needs Grasp.
 * A client whose core didn't answer has no view: nothing is known of it
 * now, so nothing is shown for it but why.
 */
import { adminOrgOf } from "@grasp-os/shared/admin/admin-snapshot-adapter";
import { adminViewOf } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";

import type { ClientAdmin } from "../clients/admin.ts";
import { formatDate } from "./words.ts";

/** One organization: the client as the console reads it, and its view when its core answered. */
export interface Organization {
  admin: ClientAdmin;
  view: AdminView | null;
}

/** The view of one answered client, counted up to the day its core answered on. */
const viewOf = (admin: ClientAdmin): AdminView | null => {
  if (admin.state !== "answered") {
    return null;
  }
  const { snapshot, client } = admin;
  const { org, state } = adminOrgOf(snapshot, {
    id: client.id,
    name: client.name,
  });
  // Core's clock is what the snapshot's days count to, not the console's.
  return adminViewOf(org, state, snapshot.now.slice(0, 10));
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
  unconfigured: "the console can’t sign or route a request for it",
  not_served: "its release is older than the admin",
  refused: "it refused the console’s request",
  core_error: "it answered with an error",
  invalid_answer: "what it answered can’t be read",
  timeout: "it didn’t answer in time",
  no_answer: "the request to it failed",
};

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
