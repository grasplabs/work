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

/** Client `clientId` as read through `reads`: shared with any read of it under way. */
const readOne = async (
  reads: OrgReads,
  clientId: string
): Promise<ClientAdmin | null> =>
  await reads.read(
    clientId,
    async () => await fetchClientAdmin({ data: { clientId } })
  );

/**
 * Every client in `clients`, as its core answers now, in their order;
 * the open one's (`open`) read on its own, as its page reads it. Null
 * when they couldn't be read at all.
 */
export const readAdmins = async (
  reads: OrgReads,
  clients: readonly GridRow[],
  open: string | undefined
): Promise<ClientAdmin[] | null> => {
  const opened =
    open !== undefined && clients.some(({ id }) => id === open)
      ? open
      : undefined;
  const [rest, one] = await Promise.all([
    (async () => {
      try {
        return await fetchClientAdmins({
          data: { except: opened === undefined ? [] : [opened] },
        });
      } catch {
        return null;
      }
    })(),
    (async () => {
      if (opened === undefined) {
        return null;
      }
      try {
        return await readOne(reads, opened);
      } catch {
        return null;
      }
    })(),
  ]);
  if (rest === null) {
    return null;
  }
  for (const admin of rest) {
    reads.remember(admin);
  }
  const order = new Map(clients.map(({ id }, index) => [id, index]));
  return [...rest, ...(one === null ? [] : [one])].toSorted(
    (a, b) =>
      (order.get(a.client.id) ?? order.size) -
      (order.get(b.client.id) ?? order.size)
  );
};

/** What a settled promise is, at once, or `notYet` while it isn't. */
const notYet = Symbol("not yet");
const peek = async <T>(value: Promise<T>): Promise<T | typeof notYet> =>
  // A promise settled already wins the race: its callbacks run first.
  await Promise.race([value, Promise.resolve(notYet)]);

/** A client whose read failed without an answer, as one that didn't answer. */
const unanswered = (client: GridRow): ClientAdmin => ({
  client,
  state: "unreachable",
  lastAnsweredAt: null,
  error: "no_answer",
});

/**
 * Organization `client`'s page as read: an answer the page has while it
 * is fresh, at once (unless asked anew, `again`); otherwise its core
 * asked now. The frame's read (`admins`) counts once it is in.
 */
export const readOrganization = async ({
  reads,
  client,
  admins,
  again,
}: {
  reads: OrgReads;
  client: GridRow;
  admins: Promise<ClientAdmin[] | null>;
  again: boolean;
}): Promise<{ read: Deferred<OrgRead> }> => {
  if (!again) {
    const framed = await peek(admins);
    const found =
      framed === notYet || framed === null
        ? undefined
        : framed.find((admin) => admin.client.id === client.id);
    if (found !== undefined) {
      reads.remember(found);
    }
    const fresh = reads.fresh(client.id, Date.now());
    if (fresh !== undefined) {
      return { read: { admin: fresh, stale: null } };
    }
  }
  const read = (async () => {
    let admin: ClientAdmin | null = null;
    try {
      admin = await readOne(reads, client.id);
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
  return again ? { read: await read } : { read };
};
