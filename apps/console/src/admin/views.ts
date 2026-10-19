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

/** Every client, in the loader's order, each with its view when its core answered. */
export const organizationsOf = (
  admins: readonly ClientAdmin[]
): Organization[] => admins.map((admin) => ({ admin, view: viewOf(admin) }));

/** Why a client's core isn't read now, in words: not deployed yet, or not answering. */
export const unreadWords = (
  admin: Extract<ClientAdmin, { state: "unreachable" }>
): string => (admin.error === "not_deployed" ? "not deployed" : "unreachable");
