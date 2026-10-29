import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { FrameFailure } from "../admin/failure.tsx";
import { AdminFrame } from "../admin/frame.tsx";
import { openClientId, readAdmins } from "../admin/org-loads.ts";
import { freshMs } from "../admin/org-reads.ts";
import type { OrgReads } from "../admin/org-reads.ts";
import { fetchPlatformSidebar } from "../admin/platform-data.ts";
import { fetchClientGrid } from "../clients/functions.ts";

import styles from "../styles.css?url";

/** What every route's loader is given: the router's own reads of clients' cores. */
interface AdminContext {
  reads: OrgReads;
}

/** The document every page renders in. */
const RootDocument = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

const Frame = () => {
  const { clients, admins, platform } = Route.useLoaderData();
  return <AdminFrame admins={admins} clients={clients} platform={platform} />;
};

/** A page there isn't, in the admin's frame. */
const NotFound = () => (
  <main className="flex flex-col gap-4 p-6">
    <h1 className="text-2xl font-medium">Not found</h1>
    <p className="text-sm">There&apos;s no such page.</p>
    <Link className="text-sm underline underline-offset-4" to="/">
      Back to the admin
    </Link>
  </main>
);

/**
 * Grasp's admin, in its own frame (src/admin/frame.tsx): the one place
 * staff manage everything, served from the root of its hostname. For
 * Grasp's staff only: a request Access doesn't vouch for gets nothing
 * (src/access.ts), so nothing here, not even that it exists, is seen by
 * anyone else. Every organization is every client the admin knows, from
 * its own D1 at once; as its core answers now (`readAdmins`) after, not
 * waited on: a page never waits on a client's core it doesn't show.
 *
 * Each read asks every client's core, whose audit log records it, so not
 * on every click: the read stands `freshMs`, and older, is read again
 * behind the page shown.
 */
export const Route = createRootRouteWithContext<AdminContext>()({
  // Beside Platform, what the admin recorded alone: no account is read.
  loader: async ({ context, location }) => {
    const [clients, platform] = await Promise.all([
      fetchClientGrid(),
      fetchPlatformSidebar(),
    ]);
    const known = clients.filter(({ status }) => status !== "offboarded");
    return {
      clients,
      platform,
      admins: readAdmins(context.reads, known, openClientId(location.pathname)),
    };
  },
  staleTime: freshMs,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Grasp admin" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  shellComponent: RootDocument,
  component: Frame,
  errorComponent: FrameFailure,
  notFoundComponent: NotFound,
});
