import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { FrameFailure } from "../admin/failure.tsx";
import { AdminFrame, FrameLoading } from "../admin/frame.tsx";
import { freshMs } from "../admin/org-reads.ts";
import type { OrgReads } from "../admin/org-reads.ts";
import { platformCounts } from "../admin/platform.ts";
import { fetchReadiness } from "../admin/readiness.ts";
import type { Readiness } from "../admin/readiness.ts";
import { fetchStaff } from "../admin/staff-functions.ts";
import { fetchClientGrid, fetchClientSummaries } from "../clients/functions.ts";
import type { ClientSummary } from "../clients/summary.ts";

import styles from "../styles.css?url";

/**
 * Damsko's styles in development (packages/ui is StyleX): its Vite plugin
 * serves them at an address of its own, with a script that fetches them
 * again after an edit, and adds both to an `index.html`, which the admin,
 * whose document is `RootDocument`, has none of; so they are added here,
 * as the plugin's README says for such a shell. A build joins them to
 * styles.css.
 */
const stylexDev = import.meta.env.DEV
  ? {
      links: [{ rel: "stylesheet", href: "/virtual:stylex.css" }],
      scripts: [{ type: "module", src: "/@id/virtual:stylex:runtime" }],
    }
  : { links: [], scripts: [] };

/** Readiness, or null when it couldn't be read: the frame never fails for it. */
const readinessOrNone = async (): Promise<Readiness | null> => {
  try {
    return await fetchReadiness();
  } catch {
    return null;
  }
};

/** What every route's loader is given (src/router.tsx). */
interface AdminContext {
  /** The router's own reads of clients' cores. */
  reads: OrgReads;
  /** The organization whose page the tab shows, if one: as the router last resolved its address. */
  shown: () => string | undefined;
}

/**
 * The document every page renders in, in Damsko's Evergreen theme, as
 * apps/web's. What Damsko's parts say themselves ("Close", "Show more")
 * is its own English, as the admin is English only; their numbers and
 * dates are in British English, as the admin's own (src/admin/words.ts),
 * never the browser's language.
 */
const RootDocument = ({ children }: { children: ReactNode }) => (
  // Marked before React wakes, by public/theme.js (light or dark) and by
  // Damsko, which notes on the root how focus last came (lib/styles.ts):
  // neither is a fault in the document the Worker sent.
  <html data-theme="evergreen" lang="en" suppressHydrationWarning>
    <head>
      <HeadContent />
    </head>
    <body>
      <I18nProvider locale="en-GB">{children}</I18nProvider>
      <Scripts />
    </body>
  </html>
);

const Frame = () => {
  const { clients, summaries, platform, staff, readiness } =
    Route.useLoaderData();
  return (
    <AdminFrame
      clients={clients}
      platform={platform}
      readiness={readiness}
      staff={staff}
      summaries={summaries}
    />
  );
};

/**
 * Grasp's admin, in its own frame (src/admin/frame.tsx): the one place
 * staff manage everything, served from the root of its hostname. For
 * Grasp's staff only: a request Access doesn't vouch for gets nothing
 * (src/access.ts), so nothing here, not even that it exists, is seen by
 * anyone else. Every organization is every client the admin knows, from
 * its own D1 at once; its summary as its core answers now
 * (`fetchClientSummaries`: counts only, which no core audits) after, not
 * waited on: a page never waits on a client's core it doesn't show. The
 * pages that show what only the snapshots hold read those themselves
 * (src/admin/org-loads.ts).
 *
 * The read asks every client's core, so not on every click: it stands
 * `freshMs`, and older, is read again behind the page shown.
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
  loader: async () => {
    const grid = fetchClientGrid();
    const staff = fetchStaff();
    // Never awaited, nor a failure of the frame: the banner shows once it
    // is in, and stays away when it couldn't be read.
    const readiness = readinessOrNone();
    // Not waited on; null when they couldn't be read at all.
    const summaries = (async (): Promise<ClientSummary[] | null> => {
      try {
        return await fetchClientSummaries();
      } catch {
        return null;
      }
    })();
    const clients = await grid;
    return {
      clients,
      staff: await staff,
      readiness,
      platform: platformCounts(clients),
      summaries,
    };
  },
  staleTime: freshMs,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Grasp admin" },
    ],
    links: [{ rel: "stylesheet", href: styles }, ...stylexDev.links],
    // Light or dark as staff chose, or as the system has it, set before first paint
    // (public/theme.js, the admin's own), so the admin never flashes light.
    scripts: [{ src: "/theme.js" }, ...stylexDev.scripts],
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
