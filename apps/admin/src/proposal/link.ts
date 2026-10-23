/**
 * Which room in Grasp's Rooms holds a client's proposal, as someone at
 * Grasp says by hand: its id, as Rooms shows it in the room's address.
 * The admin never matches one by name, which two rooms can share; a
 * person who has both in front of them links them. Audited
 * (`client.rooms_project`, the room's id as its target, none when
 * unlinked) in the same batch as the change, and only when it changes
 * something.
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";

/** Why linking was refused, as the page words it. */
export type RoomsLinkErrorCode = "unknown_client" | "project_id_invalid";

export class RoomsLinkError extends Error {
  readonly code: RoomsLinkErrorCode;

  constructor(code: RoomsLinkErrorCode, message: string) {
    super(message);
    this.name = "RoomsLinkError";
    this.code = code;
  }
}

/**
 * A link as the page sends it: the room's id, or null to unlink. The id
 * is checked here, not by the server function's validator, so a refusal
 * comes back as its code.
 */
export const roomsLinkInputSchema = z.object({
  clientId: z.string().min(1),
  projectId: z.string().nullable(),
});

/**
 * Links client `clientId` to room `projectId`, or unlinks it for null, as
 * `staff`. Returns whether it changed.
 */
export const setRoomsProject = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof roomsLinkInputSchema>
): Promise<boolean> => {
  const { clientId, projectId: given } = roomsLinkInputSchema.parse(input);
  const projectId = given === null ? null : given.trim().toLowerCase();
  if (projectId !== null && !z.uuid().safeParse(projectId).success) {
    throw new RoomsLinkError(
      "project_id_invalid",
      `Not a Rooms room id for ${clientId}`
    );
  }
  const db = adminDatabase(env.DB);
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    throw new RoomsLinkError("unknown_client", `No client ${clientId}`);
  }
  const differs =
    projectId === null
      ? isNotNull(clients.roomsProjectId)
      : or(
          isNull(clients.roomsProjectId),
          ne(clients.roomsProjectId, projectId)
        );
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ roomsProjectId: projectId, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), differs)),
    {
      action: "client.rooms_project",
      clientId,
      ...(projectId === null ? {} : { target: projectId }),
    }
  );
};
