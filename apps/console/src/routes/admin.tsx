import { createFileRoute } from "@tanstack/react-router";

import { AdminFrame } from "../admin/frame.tsx";
import { fetchClientAdmins } from "../clients/functions.ts";

/**
 * How long the organizations read for the frame stand while staff move
 * between the admin's pages: each read asks every client's core, whose
 * audit log records it, so not on every click. Older, they are read again
 * behind the page shown.
 */
const organizationsFreshMs = 60_000;

const Frame = () => <AdminFrame admins={Route.useLoaderData()} />;

/**
 * Grasp's admin, in a frame of its own (src/admin/frame.tsx), apart from
 * the console's pages: the root leaves its bar out here. For Grasp's staff
 * only, as the whole console is: a request Access doesn't vouch for gets
 * nothing (src/access.ts), so nothing here, not even that it exists, is
 * seen by anyone else. Every organization is every client the console
 * knows, as its core answers now (`fetchClientAdmins`).
 */
export const Route = createFileRoute("/admin")({
  loader: async () => await fetchClientAdmins(),
  staleTime: organizationsFreshMs,
  head: () => ({ meta: [{ title: "Grasp admin" }] }),
  component: Frame,
});
