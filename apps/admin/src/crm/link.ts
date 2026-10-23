/**
 * Which company in Grasp's Attio a client is, as someone at Grasp says by
 * hand: its record's id, as Attio shows it in the company's address. The
 * admin never matches one by name or domain, which two companies can
 * share; a person who has both in front of them links them. Audited
 * (`client.attio_company`, the record's id as its target, none when
 * unlinked) in the same batch as the change, and only when it changes
 * something.
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";

/** Why linking was refused, as the page words it. */
export type AttioLinkErrorCode = "unknown_client" | "record_id_invalid";

export class AttioLinkError extends Error {
  readonly code: AttioLinkErrorCode;

  constructor(code: AttioLinkErrorCode, message: string) {
    super(message);
    this.name = "AttioLinkError";
    this.code = code;
  }
}

/**
 * A link as the page sends it: the company record's id, or null to
 * unlink. The id is checked here, not by the server function's validator,
 * so a refusal comes back as its code.
 */
export const attioLinkInputSchema = z.object({
  clientId: z.string().min(1),
  recordId: z.string().nullable(),
});

/**
 * Links client `clientId` to Attio company `recordId`, or unlinks it for
 * null, as `staff`. Returns whether it changed.
 */
export const setAttioCompany = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof attioLinkInputSchema>
): Promise<boolean> => {
  const { clientId, recordId: given } = attioLinkInputSchema.parse(input);
  const recordId = given === null ? null : given.trim().toLowerCase();
  if (recordId !== null && !z.uuid().safeParse(recordId).success) {
    throw new AttioLinkError(
      "record_id_invalid",
      `Not an Attio record id for ${clientId}`
    );
  }
  const db = adminDatabase(env.DB);
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    throw new AttioLinkError("unknown_client", `No client ${clientId}`);
  }
  const differs =
    recordId === null
      ? isNotNull(clients.attioCompanyId)
      : or(
          isNull(clients.attioCompanyId),
          ne(clients.attioCompanyId, recordId)
        );
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ attioCompanyId: recordId, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), differs)),
    {
      action: "client.attio_company",
      clientId,
      ...(recordId === null ? {} : { target: recordId }),
    }
  );
};
