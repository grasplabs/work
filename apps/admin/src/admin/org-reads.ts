/**
 * What the admin's pages read of each organization's core, kept by the
 * page that read it: one router's own (src/router.tsx), so one browser
 * tab's, or one server render's. Every read asks the client's core
 * through the router, a round trip staff wait on, which core's audit log
 * records; so a page asks once, and reuses the answer:
 *
 * - while a read of a client is under way, whoever else asks for it (the
 *   frame and the organization's page, on the same render) waits on that
 *   one;
 * - an answer stays fresh `freshMs`, moving between an organization's
 *   sections, or coming back to it, asks its core nothing;
 * - when its core doesn't answer, or not in time, the page shows the last
 *   answer it had, marked stale with why and since when.
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
  /** Client `clientId`'s read under way, else a new one with `read`, shared until it settles. */
  read: (
    clientId: string,
    read: () => Promise<ClientAdmin | null>
  ) => Promise<ClientAdmin | null>;
  /** Keeps `admin`'s answer, unless a later one is kept. */
  remember: (admin: ClientAdmin) => void;
  /** Client `clientId`'s last answer, while it is fresh at `now`. */
  fresh: (clientId: string, now: number) => AnsweredAdmin | undefined;
  /** What to show of `admin` as read now: its answer, or the last one when it didn't answer. */
  settle: (admin: ClientAdmin, now: number) => OrgRead;
  /** Forgets everything of `clientId`, as for one offboarded. */
  forget: (clientId: string) => void;
}

/** A router's reads, empty. */
export const orgReads = (): OrgReads => {
  const underWay = new Map<string, Promise<ClientAdmin | null>>();
  const answers = new Map<string, AnsweredAdmin>();

  const remember = (admin: ClientAdmin): void => {
    if (admin.state !== "answered") {
      return;
    }
    const kept = answers.get(admin.client.id);
    if (kept === undefined || Date.parse(kept.at) <= Date.parse(admin.at)) {
      answers.set(admin.client.id, admin);
    }
  };

  return {
    read: async (clientId, read) => {
      const pending = underWay.get(clientId);
      if (pending !== undefined) {
        return await pending;
      }
      const started = (async () => {
        try {
          const admin = await read();
          if (admin !== null) {
            remember(admin);
          }
          return admin;
        } finally {
          underWay.delete(clientId);
        }
      })();
      underWay.set(clientId, started);
      return await started;
    },
    remember,
    fresh: (clientId, now) => {
      const kept = answers.get(clientId);
      return kept !== undefined && now - Date.parse(kept.at) < freshMs
        ? kept
        : undefined;
    },
    settle: (admin, now) => {
      if (admin.state === "answered" || admin.error === "not_deployed") {
        return { admin, stale: null };
      }
      const kept = answers.get(admin.client.id);
      return kept === undefined
        ? { admin, stale: null }
        : {
            admin: kept,
            stale: { error: admin.error, at: new Date(now).toISOString() },
          };
    },
    forget: (clientId) => {
      underWay.delete(clientId);
      answers.delete(clientId);
    },
  };
};
