/**
 * What Grasp's Rooms holds on one room, the proposal a client was sent:
 * read from Rooms' read-only service route (grasplabs/rooms,
 * worker/service-read.ts) with its service token (`ROOMS_READ_TOKEN`,
 * Secrets Store), at Rooms' team origin (`ROOMS_ORIGIN`).
 *
 * Threat model: the token is the admin's alone. It is read from Secrets
 * Store on the server, sent only to Rooms' origin as its bearer token, and
 * never logged, kept in D1 or sent to the browser. It can only read: Rooms
 * answers any other method 405, and the admin only ever sends a GET.
 * What Rooms answers is untrusted: it is checked against what the admin
 * reads of it, and a room other than the one asked for is refused, so one
 * company is never shown another's proposal.
 */
import { z } from "zod";

/** Rooms' service route for one room. */
export const roomsProjectPath = (projectId: string): string =>
  `/api/service/projects/${encodeURIComponent(projectId)}`;

/**
 * Why Rooms wasn't read, as a code: what is logged and shown, never an
 * answer's body.
 * - `refused`: Rooms turned the token away (401, 403), or has none set (503);
 * - `not_found`: Rooms has no such room;
 * - `invalid_answer`: the answer isn't what Rooms' rooms look like;
 * - `timeout`: no answer within the deadline;
 * - `no_answer`: the request failed otherwise.
 */
export type RoomsReadError =
  | "refused"
  | "not_found"
  | "invalid_answer"
  | "timeout"
  | "no_answer";

/** A time in milliseconds since the epoch, as Rooms gives it. */
const millis = z.number().int().nonnegative();

/** The room and its signature requests, as far as the admin reads them. */
const answerSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string(),
    clientName: z.string(),
    status: z.enum(["active", "archived"]),
    updatedAt: millis,
  }),
  signing: z.object({
    requests: z.array(
      z.object({
        signerName: z.string(),
        signerEmail: z.string(),
        status: z.enum(["pending", "signed", "revoked"]),
        createdAt: millis,
        expiresAt: millis,
        signedAt: millis.nullable(),
      })
    ),
  }),
});
export type RoomsRecords = z.output<typeof answerSchema>;

/** What reading one room takes. */
export interface RoomsRead {
  origin: string;
  token: string;
  projectId: string;
  signal: AbortSignal;
}

/**
 * Room `projectId` and what was signed in it, or why it wasn't read.
 * Throws only when the request itself fails or is stopped.
 */
export const readRoomsProject = async ({
  origin,
  token,
  projectId,
  signal,
}: RoomsRead): Promise<
  { records: RoomsRecords } | { error: RoomsReadError }
> => {
  const response = await fetch(new URL(roomsProjectPath(projectId), origin), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    // A redirect isn't followed (Workers has no "error"): it isn't ok, so no answer.
    redirect: "manual",
    signal,
  });
  if ([401, 403, 503].includes(response.status)) {
    return { error: "refused" };
  }
  if (response.status === 404) {
    return { error: "not_found" };
  }
  if (!response.ok) {
    return { error: "no_answer" };
  }
  const answer = answerSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!answer.success || answer.data.project.id !== projectId) {
    return { error: "invalid_answer" };
  }
  return { records: answer.data };
};
