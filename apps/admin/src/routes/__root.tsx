import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { FrameFailure } from "../admin/failure.tsx";
import { AdminFrame, FrameLoading } from "../admin/frame.tsx";
import { openClientId, readAdmins } from "../admin/org-loads.ts";
import { freshMs } from "../admin/org-reads.ts";
import type { OrgReads } from "../admin/org-reads.ts";
import { platformCounts } from "../admin/platform.ts";
import { fetchClientGrid } from "../clients/functions.ts";

import styles from "../styles.css?url";

/** What every route's loader is given (src/router.tsx). */
interface AdminContext {
  /** The router's own reads of clients' cores. */
  reads: OrgReads;
  /** The organization whose page the tab shows, if one: as the router last resolved its address. */
  shown: () => string | undefined;
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
  // Rendered in the browser alone: the Worker answers a page with the
  // document (`RootDocument`, with `head`) and nothing in it, and every
  // route below inherits this. A tool behind Access gains nothing from
  // server rendering. Loaders run in the browser, reading through server
  // functions, each a request of its own past the Access check.
  ssr: false,
  // Beside Platform, what the admin recorded alone: no account is read.
  // Every client's core is asked at once, beside the grid, never after it.
  loader: async ({ context, location, preload }) => {
    const grid = fetchClientGrid();
    const open = openClientId(location.pathname);
    const frame = readAdmins(
      context.reads,
      grid,
      open,
      // Loaded while the tab shows it (src/admin/org-loads.ts).
      open !== undefined && !preload && context.shown() === open
    );
    const clients = await grid;
    return {
      clients,
      platform: platformCounts(clients),
      admins: frame.admins,
      adminsAsked: frame.asked,
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
    // Light or dark as the system has it, set before first paint
    // (public/theme.js, the admin's own), so the admin never flashes light.
    scripts: [{ src: "/theme.js" }],
  }),
  shellComponent: RootDocument,
  // The document's body until the frame's records are in: also what the
  // Worker sends, so the first paint is the frame, never a blank page.
  pendingComponent: FrameLoading,
  // At once, as the document already shows it, and gone the moment the
  // records are in: never a blank moment, never a wait for the skeleton.
  pendingMs: 0,
  pendingMinMs: 0,
  component: Frame,
  errorComponent: FrameFailure,
});
