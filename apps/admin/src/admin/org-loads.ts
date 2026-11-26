/**
 * How the admin's pages load what clients' cores answer, never in the
 * way of the page: the frame and an organization's shell come from the
 * admin's own D1 at once, and each core's answer comes after, into the
 * part of the page that needs it (src/admin/settled.tsx).
 *
 * - The frame reads every client's summary (`fetchClientSummaries`, in
 *   src/routes/__root.tsx): counts only, which no core audits.
 * - A page that shows what only the snapshots hold (Home, Apps asked
 *   for, Stephen Lab, Ask Grasp) reads every client's (`readEveryAdmin`),
 *   a few at a time, each core's audit log recording it.
 * - The open organization's page reads its own client alone, within a
 *   shorter deadline (`fetchClientAdmin`), so a slow client elsewhere
 *   never holds it up.
 * - An answer the page already has, from either, is reused while fresh
 *   (src/admin/org-reads.ts): moving between sections reads nothing.
 *
 * Neither ever rejects: a read that fails is a client not answering.
 */

import type { ClientAdmin } from "../clients/admin.ts";
import { fetchClientAdmin, fetchClientAdmins } from "../clients/functions.ts";
import type { GridRow } from "../clients/grid.ts";
import type { OrgRead, OrgReads } from "./org-reads.ts";
import type { Deferred } from "./settled.tsx";

const openOrganization = /^\/organizations\/(?<clientId>[^/]+)/u;

/** The client whose page `pathname` is, if it is one. */
export const openClientId = (pathname: string): string | undefined => {
  const clientId = openOrganization.exec(pathname)?.groups?.clientId;
  return clientId === undefined ? undefined : decodeURIComponent(clientId);
};

/**
 * Client `clientId` as read through `reads`: shared with any read of it
 * under way, or asked `anew` only one begun in the router's load under way.
 */
const readOne = async (
  reads: OrgReads,
  clientId: string,
  options: { anew?: boolean; after?: number } = {}
): Promise<ClientAdmin | null> =>
  await reads.read(
    clientId,
    async () => await fetchClientAdmin({ data: { clientId } }),
    options
  );

/**
 * Every client, as its core answers now, in the grid's order, each answer
 * kept in `reads` for its organization's page to reuse while fresh; null
 * when they couldn't be read at all.
 */
export const readEveryAdmin = async (
  reads: OrgReads
): Promise<ClientAdmin[] | null> => {
  const asked = reads.ask();
  try {
    const admins = await fetchClientAdmins();
    for (const admin of admins) {
      reads.remember(admin, asked);
    }
    return admins;
  } catch {
    return null;
  }
};

/**
 * The loader of a page of every organization: their snapshots, read
 * without waiting (`readEveryAdmin`), once the page is opened. A preload
 * (a link pointed at) reads nothing: each read is in every core's audit
 * log as staff opening it.
 */
export const loadEveryAdmin = ({
  context,
  preload,
}: {
  context: { reads: OrgReads };
  preload: boolean;
}): { admins: Promise<ClientAdmin[] | null> | undefined } => ({
  admins: preload ? undefined : readEveryAdmin(context.reads),
});

/** A client whose read failed without an answer, as one that didn't answer. */
const unanswered = (client: GridRow): ClientAdmin => ({
  client,
  state: "unreachable",
  lastAnsweredAt: null,
  error: "no_answer",
});

/**
 * Organization `client`'s page as read: an answer the page has while it
 * is fresh, at once, when staff come to the page (a navigation, a
 * preload); otherwise its core asked now, unless only preloaded
 * (undefined: asked once opened).
 *
 * Coming to the page, an answer kept from before the last change staff
 * made (src/router.tsx) is never shown as current: the page takes a read
 * asked after that change if one is under way, and otherwise asks its
 * core alone; not answering, it shows the answer it had, marked stale.
 * An answer asked after it shows at once.
 *
 * The rule for when a fresh answer may be reused: only on coming to the
 * page. When the page loads while the tab already shows this
 * organization (`onIt`, as the router resolved the tab's address): after
 * any change staff made there (every change reads the page again,
 * `router.invalidate`), Read again, Try again, or its answer going stale,
 * its core is asked anew, by a read begun in that load, and the page
 * waits for that answer. So a change can't be followed by the answer from
 * before it, whichever action made it: none of them has to say so, and
 * nothing is remembered of where the tab was.
 */
export const readOrganization = async ({
  reads,
  client,
  onIt,
  preload,
}: {
  reads: OrgReads;
  client: GridRow;
  /**
   * The tab shows this organization's page already: the address the
   * router last resolved is one of its pages. Never a navigation to it,
   * which the router may count as staying, from another organization.
   */
  onIt: boolean;
  /** Only pointed at, not opened: what the page has, its core never asked. */
  preload: boolean;
}): Promise<{ read: Deferred<OrgRead> | undefined }> => {
  // Loading on the organization the tab shows: a change, Read again, Try
  // again, a stale answer. Coming to it takes the answer it has.
  const anew = onIt && !preload;
  // An answer kept from before the last change staff made
  // (src/router.tsx) is never shown as current: a read asked after that
  // change answers for it, if one is under way, and otherwise its core is
  // asked alone. One asked after it shows at once.
  if (!anew) {
    const fresh = reads.fresh(client.id, Date.now());
    if (fresh !== undefined && !reads.predates(client.id)) {
      // Still marked stale when reading it again failed since.
      return { read: reads.settle(fresh, Date.now()) };
    }
  }
  // Every read of a core is audited as staff opening the organization:
  // a link pointed at, or focused, preloads its shell alone.
  if (preload) {
    return { read: undefined };
  }
  const read = (async () => {
    let admin: ClientAdmin | null = null;
    try {
      // Not answering, the page shows the answer it had, marked stale.
      admin = await readOne(reads, client.id, {
        anew,
        after: reads.lastChange(),
      });
    } catch {
      // As a core that didn't answer.
    }
    return reads.settle(admin ?? unanswered(client), Date.now());
  })();
  // Asked anew, the page keeps what it shows until the answer is in, so
  // the load waits for it: whoever asked sees when it is done. Otherwise
  // it isn't waited on, so the page shows at once and waits for it in
  // place; held in an object, as an async function awaits a promise it
  // returns.
  return anew ? { read: await read } : { read };
};
