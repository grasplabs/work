import { z } from "zod";

// Who may read an item where it lives, as the system it lives in lists
// them (GRA-1761): what a sync hands core for each item, and core turns
// into the Brain's readers (core's source-readers.ts `principalOfReader`).
// Each reader is named in the company's own tenant by what that provider's
// ID tokens vouch for, which core matches only against accounts a person
// proved are theirs, by signing in with them or connecting them.

/**
 * How old a copied reader list, or the proof that an account is
 * someone's, may be: a day. The sync reads every list again within it
 * (GRA-1719), and a connection's address counts only while its provider
 * confirmed it within it (core's source-readers.ts).
 */
export const readerProofMaxAgeMs = 24 * 60 * 60 * 1000;

/** The systems whose sharing is copied: connect's provider IDs for them. */
export const sourceReaderProviders = ["google", "microsoft"] as const;

/** One part of a reader's ID: never empty, never ":", which joins the parts. */
const partSchema = z
  .string()
  .min(1)
  .refine((part) => part.isWellFormed() && !part.includes(":"), {
    message: "Not one part of a reader's ID",
  });

/**
 * Where a reader is: the system, and the company's tenant in it, as
 * connect's connections name it (an Entra tenant ID, a Google Workspace's
 * primary domain).
 */
const placeShape = {
  provider: z.enum(sourceReaderProviders),
  tenant: partSchema,
};

/**
 * One reader of an item:
 *
 * - `account`: one account, by what the provider's ID tokens vouch for:
 *   an Entra object ID for Microsoft, the address for Google;
 * - `group`: a group in the tenant's directory, by its ID; nobody reads by
 *   it until core knows its members;
 * - `tenant`: everyone in the tenant, only where they can open the item
 *   without a link;
 * - `link`: whoever has a link ("anyone with the link", or everyone in the
 *   organization with it): nobody, as a link alone gives no one access.
 */
export const sourceReaderSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("account"),
    ...placeShape,
    account: partSchema,
  }),
  z.strictObject({
    kind: z.literal("group"),
    ...placeShape,
    group: partSchema,
  }),
  z.strictObject({ kind: z.literal("tenant"), ...placeShape }),
  z.strictObject({ kind: z.literal("link") }),
]);
export type SourceReader = z.infer<typeof sourceReaderSchema>;
