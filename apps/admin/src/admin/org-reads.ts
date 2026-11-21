/**
 * What the admin's pages read of each organization's core, kept by the
 * page that read it: one router's own (src/router.tsx), so one browser
 * tab's. Every read asks the client's core
 * through the router, a round trip staff wait on, which core's audit log
 * records; so a page asks once, and reuses the answer:
 *
 * - while a read of a client is under way, whoever else asks for it (the
 *   frame and the organization's page, on the same render) waits on that
 *   one; one asked anew, after a change, waits only on a read begun in
 *   the same load of the router, never on an older one;
 * - the newest question wins: answers are ordered by when they were
 *   asked, never by when they came in, so a slow read asked before a
 *   change can't replace the answer asked after it, whoever asked
 *   (the page alone, or the frame for every client);
 * - an answer stays fresh `freshMs`, moving between an organization's
 *   sections, or coming back to it, asks its core nothing, unless it was
 *   asked before a change staff made since: then a read asked after the
 *   change answers for it (src/admin/org-loads.ts);
 * - when its core doesn't answer, or not in time, the page shows the last
 *   answer it had, marked stale with why and since when, until a later
 *   read answers.
 *
 * Nothing of it outlives the tab, and nothing is shared between staff
 * members: each answer is what core answered the one staff member whose
 * page this is, which its audit log recorded as theirs. That is why it
 * is kept here and not in the admin's D1, which holds no client data,
 * only when each core last answered (`clientAdminReads`); nor in a
 * cache in front of core, which would show one staff member's read to
 * another without core recording it. An offboarded client's answers are
 * forgotten.
 */
import type { AdminReadError, ClientAdmin } from "../clients/admin.ts";

/** A client whose core answered. */
export type AnsweredAdmin = Extract<ClientAdmin, { state: "answered" }>;

/** An organization's page as read: what to show, and when it is an older answer, why. */
export interface OrgRead {
  admin: ClientAdmin;
  /** Set when `admin` is the last answer, shown because reading it again failed now. */
  stale: { error: AdminReadError; at: string } | null;
}

/** How long an answer stands before the page asks its core again. */
export const freshMs = 60_000;

/** The reads one router keeps. */
export interface OrgReads {
  /**
   * Client `clientId`'s read under way, else a new one with `read`, shared
   * until it settles. Asked `anew`, only a read begun in the router's
   * load under way counts as under way: one begun before it may have
   * been answered before the change that load shows. Asked for one
   * `after` a number of reads, only a read asked after those counts.
   */
  read: (
    clientId: string,
    read: () => Promise<ClientAdmin | null>,
    options?: { anew?: boolean; after?: number }
  ) => Promise<ClientAdmin | null>;
  /** The router began a load (src/router.tsx): every read asked before it is older. */
  loadBegan: () => void;
  /** Marks a read asked now, before it is sent: what its answers are `remember`ed with. */
  ask: () => number;
  /** When the read of client `clientId` under way was asked (`ask`), if one is. */
  reading: (clientId: string) => number | undefined;
  /**
   * Staff may have changed something (src/router.tsx: a reload of the
   * frame, as every change makes): answers asked before now may be
   * outdated.
   */
  changed: () => void;
  /**
   * How many reads had been asked by the first change after client
   * `clientId`'s kept answer was asked: that answer may predate it, and
   * only a read asked after that many holds it for sure. Undefined while
   * no change came since (or none is kept).
   */
  changedSince: (clientId: string) => number | undefined;
  /**
   * Keeps `admin`'s answer to a read asked at `asked`, unless an answer
   * to a read asked later is kept, or the client was forgotten since; a
   * later one ends a failed read's mark.
   */
  remember: (admin: ClientAdmin, asked: number) => void;
  /** Client `clientId`'s last answer, while it is fresh at `now`. */
  fresh: (clientId: string, now: number) => AnsweredAdmin | undefined;
  /**
   * What to show of `admin` as read now: its answer, or the last one when
   * it didn't answer; either marked stale while a read since it failed.
   */
  settle: (admin: ClientAdmin, now: number) => OrgRead;
  /** Forgets everything of `clientId`, as for one offboarded: reads asked before keep nothing. */
  forget: (clientId: string) => void;
}

/** A router's reads, empty. */
export const orgReads = (): OrgReads => {
  /** Reads asked so far, counted: each read's place in that order. */
  let asks = 0;
  /** How many were asked before the router's load under way began. */
  let loadFrom = 0;
  /** How many were asked when staff last changed something. */
  let lastChange = 0;
  /** Each client's read under way, with when it was asked. */
  const underWay = new Map<
    string,
    { asked: number; answer: Promise<ClientAdmin | null> }
  >();
  /**
   * Each client's answer kept, with when the read it answered was asked,
   * and how many had been asked by the first change after that (unset
   * while none came): all a read under way is compared with, so nothing
   * more of the changes is kept than one number for each answer.
   */
  const answers = new Map<
    string,
    { admin: AnsweredAdmin; asked: number; changedAt?: number }
  >();
  /** Why the last read failed and when, for a client with an answer kept, until a later one. */
  const failed = new Map<string, NonNullable<OrgRead["stale"]>>();
  /** For a client forgotten, how many reads had been asked then: none of those keeps anything. */
  const forgotten = new Map<string, number>();

  const ask = (): number => {
    asks += 1;
    return asks;
  };

  const remember = (admin: ClientAdmin, asked: number): void => {
    const clientId = admin.client.id;
    if (admin.state !== "answered" || asked <= (forgotten.get(clientId) ?? 0)) {
      return;
    }
    const kept = answers.get(clientId);
    if (kept === undefined || kept.asked <= asked) {
      // An answer to a read asked before the last change, kept only now:
      // a change came after it was asked, at the latest then, so it counts
      // as changed from when it was asked.
      answers.set(
        clientId,
        asked <= lastChange
          ? { admin, asked, changedAt: asked }
          : { admin, asked }
      );
    }
    if (kept === undefined || kept.asked < asked) {
      failed.delete(clientId);
    }
  };

  return {
    read: async (clientId, read, { anew = false, after = 0 } = {}) => {
      const pending = underWay.get(clientId);
      if (
        pending !== undefined &&
        pending.asked > Math.max(after, anew ? loadFrom : 0)
      ) {
        return await pending.answer;
      }
      const asked = ask();
      const answer = (async () => {
        const admin = await read();
        if (admin !== null) {
          remember(admin, asked);
        }
        return admin;
      })();
      const begun = { asked, answer };
      underWay.set(clientId, begun);
      try {
        return await answer;
      } finally {
        // Unless a read asked anew took its place since.
        if (underWay.get(clientId) === begun) {
          underWay.delete(clientId);
        }
      }
    },
    loadBegan: () => {
      loadFrom = asks;
    },
    ask,
    reading: (clientId) => underWay.get(clientId)?.asked,
    changed: () => {
      lastChange = asks;
      // The first change after each answer kept, never moved by a later one.
      for (const kept of answers.values()) {
        kept.changedAt ??= asks;
      }
    },
    changedSince: (clientId) => answers.get(clientId)?.changedAt,
    remember,
    fresh: (clientId, now) => {
      const kept = answers.get(clientId)?.admin;
      return kept !== undefined && now - Date.parse(kept.at) < freshMs
        ? kept
        : undefined;
    },
    settle: (admin, now) => {
      if (admin.state === "answered") {
        return { admin, stale: failed.get(admin.client.id) ?? null };
      }
      const kept = answers.get(admin.client.id)?.admin;
      if (admin.error === "not_deployed" || kept === undefined) {
        return { admin, stale: null };
      }
      const stale = { error: admin.error, at: new Date(now).toISOString() };
      failed.set(admin.client.id, stale);
      return { admin: kept, stale };
    },
    forget: (clientId) => {
      underWay.delete(clientId);
      answers.delete(clientId);
      failed.delete(clientId);
      forgotten.set(clientId, asks);
    },
  };
};
