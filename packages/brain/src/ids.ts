import { z } from "zod";

// The IDs the Brain hands out and takes. The brand exists only in the type
// system: a `CollectionId` can't be passed where a `DocumentId` is
// expected, and a plain string becomes one only by parsing it. IDs are
// opaque: never empty, and short enough to name things in an audit event.

/** The longest an ID may be. */
export const idMaxLength = 256;

/** An identifier the Brain takes: non-empty, at most `idMaxLength`. */
export const idSchema = z.string().min(1).max(idMaxLength);

/* @__NO_SIDE_EFFECTS__ */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the brand is type-only by design
const brandedId = <Brand extends string>() => idSchema.brand<Brand>();

/** A collection: a set of documents with one audience, as the host names it. */
export const collectionIdSchema = brandedId<"CollectionId">();
export type CollectionId = z.infer<typeof collectionIdSchema>;

/** A document in a collection. */
export const documentIdSchema = brandedId<"DocumentId">();
export type DocumentId = z.infer<typeof documentIdSchema>;

/** A memory record. */
export const memoryIdSchema = brandedId<"MemoryId">();
export type MemoryId = z.infer<typeof memoryIdSchema>;

/** A command's receipt. */
export const brainReceiptIdSchema = brandedId<"BrainReceiptId">();
export type BrainReceiptId = z.infer<typeof brainReceiptIdSchema>;
