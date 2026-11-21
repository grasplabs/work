/**
 * How the admin's pages load what clients' cores answer, never in the
 * way of the page: the frame and an organization's shell come from the
 * admin's own D1 at once, and each core's answer comes after, into the
 * part of the page that needs it (src/admin/settled.tsx).
 *
 * - The frame reads every client but the one whose page is open, all at
 *   once, a few at a time (`fetchClientAdmins`): its sidebar's counts,
 *   the overview's organizations.
 * - The open organization's page reads its own client alone, within a
 *   shorter deadline (`fetchClientAdmin`), so a slow client elsewhere
 *   never holds it up. The frame takes that same read for its sidebar.
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

/** Every client as `readAdmins` reads them, asked at `asked`. */
const adminsAnswer = async (
  reads: OrgReads,
  asked: number,
  clients: Promise<readonly GridRow[]>,
  open: string | undefined,
  anew: boolean
): Promise<ClientAdmin[] | null> => {
  const [rest, one, rows] = await Promise.all([
    (async () => {
      try {
        return await fetchClientAdmins({
          data: { except: open === undefined ? [] : [open] },
        });
      } catch {
        return null;
      }
    })(),
    (async () => {
      if (open === undefined) {
        return null;
      }
      try {
        return await readOne(reads, open, { anew });
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        return await clients;
      } catch {
        return [];
      }
    })(),
  ]);
  if (rest === null) {
    return null;
  }
  for (const admin of rest) {
    reads.remember(admin, asked);
  }
  const order = new Map(rows.map(({ id }, index) => [id, index]));
  return [...rest, ...(one === null ? [] : [one])].toSorted(
    (a, b) =>
      (order.get(a.client.id) ?? order.size) -
      (order.get(b.client.id) ?? order.size)
  );
};

/**
 * Every client, as its core answers now, in the order of `clients` (the
 * grid, read beside it rather than before it: neither waits on the
 * other); the open one's (`open`) read on its own, as its page reads it:
 * `anew` when the tab shows it already, so the page's read in the same
 * load joins this one. Null when they couldn't be read at all. With when
 * they were asked (`asked`, src/admin/org-reads.ts), so a page can tell
 * whether they are newer than an answer it has.
 */
export const readAdmins = (
  reads: OrgReads,
  clients: Promise<readonly GridRow[]>,
  open: string | undefined,
  anew: boolean
): { asked: number; admins: Promise<ClientAdmin[] | null> } => {
  const asked = reads.ask();
  return { asked, admins: adminsAnswer(reads, asked, clients, open, anew) };
};

/**
 * How long an organization's page waits on the frame's read for its
 * client before asking it alone: a little past the page's own deadline
 * (3 s, `pageReadOptions`), as the frame's waits on every client.
 */
export const frameWaitMs = 4000;

/**
 * Waits for the frame's read (`admins`) to be in, which keeps what it
 * read (`readAdmins`), but no longer than `frameWaitMs`.
 */
const frameIn = async (admins: Promise<unknown>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      admins,
      // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form here
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, frameWaitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

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
 * (undefined: asked once opened). The frame's read (`admins`) counts once
 * it is in.
 *
 * Coming to the page, an answer kept from before the last change staff
 * made (src/router.tsx) is never shown as current: the page takes a read
 * asked after that change if one is under way (the frame's, or one of
 * its own), and otherwise asks its core alone; not answering, it shows
 * the answer it had, marked stale. An answer asked after it shows at
 * once.
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
  admins,
  adminsAsked,
  onIt,
  preload,
}: {
  reads: OrgReads;
  client: GridRow;
  admins: Promise<ClientAdmin[] | null>;
  /** When the frame's read was asked (`readAdmins`). */
  adminsAsked: number;
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
  // again, a stale answer. Coming to it takes the answer it has, or the
  // frame's read.
  const anew = onIt && !preload;
  // An answer kept from before the last change staff made
  // (src/router.tsx) is never shown as current: a read asked after that
  // change answers for it, the frame's or its own, if one is under way,
  // and otherwise its core is asked alone. One asked after it shows at
  // once.
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
    // When the frame reads this client alone (the open one), the page
    // takes that read as soon as it answers (`readOne` joins it), never
    // waiting on other cores. Otherwise the frame's read of every client,
    // if asked after the last change, has this one in it:
    // waited on, rather than asking its core, Stripe and Attio a second
    // time, unless it holds up the page past `frameWaitMs`. When neither
    // gives an answer asked after the last change, its core is asked alone.
    if (!anew) {
      // Only a read asked after the last change holds every change made.
      const after = reads.lastChange();
      const own = reads.reading(client.id);
      if ((own === undefined || own <= after) && adminsAsked > after) {
        await frameIn(admins);
      }
      // An answer kept by now, asked after the last change, is not asked
      // for again: the frame's, or one that came in while the page waited.
      const kept = reads.fresh(client.id, Date.now());
      if (kept !== undefined && !reads.predates(client.id)) {
        return reads.settle(kept, Date.now());
      }
    }
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
