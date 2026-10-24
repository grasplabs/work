import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AdminFrame } from "../admin/frame.tsx";
import { fetchPlatformSidebar } from "../admin/platform-data.ts";
import { fetchClientAdmins } from "../clients/functions.ts";

import styles from "../styles.css?url";

/**
 * How long the organizations read for the frame stand while staff move
 * between the admin's pages: each read asks every client's core, whose
 * audit log records it, so not on every click. Older, they are read again
 * behind the page shown.
 */
const organizationsFreshMs = 60_000;

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
  const { admins, platform } = Route.useLoaderData();
  return <AdminFrame admins={admins} platform={platform} />;
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
 * anyone else. Every organization is every client the admin knows, as its
 * core answers now (`fetchClientAdmins`).
 */
export const Route = createRootRoute({
  // Beside Platform, what the admin recorded alone: no account is read.
  loader: async () => {
    const [admins, platform] = await Promise.all([
      fetchClientAdmins(),
      fetchPlatformSidebar(),
    ]);
    return { admins, platform };
  },
  staleTime: organizationsFreshMs,
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
  notFoundComponent: NotFound,
});
