import { deadline } from "@grasp-os/shared/deadline";
/**
 * The proposal a company was sent and what of it was signed, for the
 * admin's Contract: its room in Grasp's Rooms, linked by hand
 * (`clients.roomsProjectId`, src/proposal/link.ts), read each time the
 * admin reads its organizations (src/proposal/rooms.ts). The admin keeps
 * only the link; nothing Rooms answers is stored.
 *
 * What reaches the browser is `Proposal`: what the page shows, never
 * Rooms' answer as it came, and never the token.
 */
import { log } from "@grasp-os/shared/log";
import { isNotNull } from "drizzle-orm";

import { ifStored } from "../clients/grid.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { storeSecret } from "../deploy/context.ts";
import { readRoomsProject } from "./rooms.ts";
import type { RoomsReadError, RoomsRecords } from "./rooms.ts";

/** One signature request in the room, as the page lists it. */
export interface ProposalSignature {
  /** Who was asked to sign, as Rooms names them. */
  signer: string;
  email: string;
  /** Signed; waiting for them; withdrawn; or past its last day unsigned. */
  status: "signed" | "pending" | "revoked" | "expired";
  /** The day it was sent. */
  sent: string;
  /** The day it was signed; null until it is. */
  signed: string | null;
}

/** What Rooms says of the room, worked out for the page. */
export interface ProposalRoom {
  /** The room's name in Rooms. */
  name: string;
  /** The company the room is for, as Rooms names it. */
  clientName: string;
  /** Whether the room is archived in Rooms. */
  archived: boolean;
  /** The day the room last changed. */
  updated: string;
  /** The room in Rooms. */
  url: string;
  /** Its signature requests, the newest first. */
  signatures: ProposalSignature[];
}

/**
 * The company's proposal, as far as it is read:
 * - `not_connected`: there's no token or no origin, so Rooms isn't read at
 *   all; the room it is linked to, if any, is still said;
 * - `not_linked`: nobody at Grasp linked it to a room yet;
 * - `unread`: Rooms wasn't read now, and why;
 * - `read`: what Rooms says.
 */
export type Proposal =
  | { state: "not_connected"; projectId: string | null }
  | { state: "not_linked" }
  | { state: "unread"; projectId: string; error: RoomsReadError }
  | { state: "read"; projectId: string; room: ProposalRoom };

/** The day a time in milliseconds falls on, in UTC. */
const dayOf = (millis: number): string =>
  new Date(millis).toISOString().slice(0, 10);

/** The room in Rooms' own pages. */
export const roomUrl = (origin: string, projectId: string): string =>
  new URL(`/rooms/${encodeURIComponent(projectId)}`, origin).href;

/** What Rooms' records on a room say, at `now`, for the page. */
export const roomOf = (
  { project, signing }: RoomsRecords,
  url: string,
  now: Date
): ProposalRoom => ({
  name: project.name,
  clientName: project.clientName,
  archived: project.status === "archived",
  updated: dayOf(project.updatedAt),
  url,
  signatures: signing.requests.map((request) => ({
    signer: request.signerName,
    email: request.signerEmail,
    status:
      request.status === "pending" && request.expiresAt < now.getTime()
        ? "expired"
        : request.status,
    sent: dayOf(request.createdAt),
    signed: request.signedAt === null ? null : dayOf(request.signedAt),
  })),
});

/** Where and with what Rooms is read, or null while either is missing. */
export const roomsAccess = async (
  env: Env
): Promise<{ origin: string; token: string } | null> => {
  const origin = env.ROOMS_ORIGIN ?? "";
  if (!origin.startsWith("https://")) {
    return null;
  }
  const token = await ifStored(
    async () => await storeSecret(env, "ROOMS_READ_TOKEN")
  );
  return token === null ? null : { origin, token };
};

/** The room each linked client is linked to, by the client's id. */
export const roomsLinks = async (
  db: AdminDatabase
): Promise<Map<string, string>> => {
  const rows = await db
    .select({ id: clients.id, projectId: clients.roomsProjectId })
    .from(clients)
    .where(isNotNull(clients.roomsProjectId));
  return new Map(
    rows.flatMap(({ id, projectId }) =>
      projectId === null ? [] : [[id, projectId] as const]
    )
  );
};

/** What reading one client's proposal takes. */
export interface ProposalRead {
  access: { origin: string; token: string } | null;
  projectId: string | null;
  clientId: string;
  timeoutMs: number;
}

/**
 * Client `clientId`'s proposal: not read without access or a linked room,
 * else read from Rooms within `timeoutMs`. Never throws.
 */
export const proposalOf = async ({
  access,
  projectId,
  clientId,
  timeoutMs,
}: ProposalRead): Promise<Proposal> => {
  if (access === null) {
    return { state: "not_connected", projectId };
  }
  if (projectId === null) {
    return { state: "not_linked" };
  }
  const limit = deadline(timeoutMs);
  let error: RoomsReadError = "no_answer";
  try {
    const read = await readRoomsProject({
      ...access,
      projectId,
      signal: limit.signal,
    });
    if ("records" in read) {
      return {
        state: "read",
        projectId,
        room: roomOf(
          read.records,
          roomUrl(access.origin, projectId),
          new Date()
        ),
      };
    }
    ({ error } = read);
  } catch {
    error = limit.stopped() === "timeout" ? "timeout" : "no_answer";
  } finally {
    limit.clear();
  }
  log.warn("admin.proposal_unread", { clientId, error });
  return { state: "unread", projectId, error };
};
