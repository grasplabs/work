import { z } from "zod";

import type { BrainStore } from "./store.ts";
import { foldForSearch } from "./words.ts";

// The Brain's one way in. Its host (core) adds sources and recalls them
// through `Brain`, and nothing else reaches the store: its data lives in
// the store's own Durable Object, which only its own code can read.
//
// The Brain knows no people, teams or Apps. A source says who may read it
// as principals, opaque IDs the host names: a person, or a group. A
// recall names its reader the same way: the person, and every group the
// host counts them in now. The host decides both, from its own records,
// never from what a caller claims: so a group's membership is the host's,
// read at each recall, and a change in it rewrites nothing here.

/** Most bytes of a source's text (UTF-8), as given and as indexed. */
export const sourceTextMaxBytes = 1_000_000;

/** Most characters of a question. */
export const questionMaxLength = 2000;

/** Most groups a reader can be in. */
export const readerGroupsMax = 1000;

/** Most characters of a principal's ID. */
export const principalMaxLength = 256;

/** Most chunks one recall returns. */
export const recallLimit = 10;

/** Most characters of a source's identity, and of a change's key. */
export const sourceIdMaxLength = 256;

/**
 * A string as the Brain takes it: well-formed, no half of a surrogate pair
 * on its own. Every string the Brain hashes, compares or keeps as bytes is
 * one: encoding turns a lone half into U+FFFD, so two strings would become
 * one file, one key or one name, and what is read back would not be what
 * was given. Checked first, before anything encodes it; the host checks
 * with the same rule.
 */
export const wellFormedString = () =>
  z.string().refine((value) => value.isWellFormed(), {
    message: "Holds an unpaired surrogate",
    abort: true,
  });

const principalSchema = wellFormedString().min(1).max(principalMaxLength);

const encoder = new TextEncoder();

/** `text`'s length in UTF-8 bytes. */
const byteLengthOf = (text: string): number => encoder.encode(text).byteLength;

/**
 * A source's identity, as the host names it (this upload, this chat): the
 * same for every version of it, so a new version of the same thing is
 * added under the same identity. The host keeps one producer's sources
 * apart from another's in how it names them.
 */
export const sourceIdSchema = wellFormedString().min(1).max(sourceIdMaxLength);
export type SourceId = z.infer<typeof sourceIdSchema>;

/**
 * The key of one change to a source, from its producer: an upstream
 * revision, a message id, or an id minted before the first try. Unique per
 * source: every retry of that change carries it.
 */
export const changeKeySchema = wellFormedString().min(1).max(sourceIdMaxLength);

/** A version of a source: 1 for its first, counting up. */
export const versionSchema = z.int().positive();

/**
 * Who may read a source: one person (`owner`: theirs alone, admins
 * included), a named group (`audience`), or nobody, when who may read it
 * isn't known (`none`).
 */
export const accessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner"), person: principalSchema }),
  z.strictObject({ kind: z.literal("audience"), group: principalSchema }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type Access = z.infer<typeof accessSchema>;

/**
 * A version of a source to add: which source, the change it is, its text,
 * and who may read this version.
 */
export const newSourceSchema = z.strictObject({
  source: sourceIdSchema,
  change: changeKeySchema,
  text: wellFormedString()
    // A text of whitespace alone has no passage to keep or find.
    .regex(/\S/u, { message: "Holds no text" })
    .refine((text) => byteLengthOf(text) <= sourceTextMaxBytes, {
      message: `At most ${sourceTextMaxBytes} bytes`,
      abort: true,
    })
    // Folding can grow a text many times (a compatibility form such as
    // "ﷺ" is 3 bytes, and 33 folded), so the bound holds for what the
    // word index takes too.
    .refine((text) => byteLengthOf(foldForSearch(text)) <= sourceTextMaxBytes, {
      message: `At most ${sourceTextMaxBytes} bytes as indexed`,
    }),
  access: accessSchema,
});
export type NewSource = z.infer<typeof newSourceSchema>;

/**
 * Who reads, as the host resolves them now: the person, and each group the
 * host counts them in.
 */
export const readerSchema = z.strictObject({
  person: principalSchema,
  groups: z.array(principalSchema).max(readerGroupsMax),
});
export type Reader = z.infer<typeof readerSchema>;

/** A recall: a question, in the reader's words, and the reader. */
export const recallRequestSchema = z.strictObject({
  question: wellFormedString().max(questionMaxLength),
  reader: readerSchema,
});
export type RecallRequest = z.infer<typeof recallRequestSchema>;

/** A version of a source, as an add records it. */
export interface SourceVersionRef {
  source: SourceId;
  version: number;
}

/** A chunk a recall found: a passage of a source's current version. */
export interface RecalledChunk extends SourceVersionRef {
  text: string;
}

/** What a recall found the reader may read, best first. */
export interface Recalled {
  chunks: RecalledChunk[];
}

/** A version to read whole, and who reads it. */
export const versionRequestSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
  reader: readerSchema,
});
export type VersionRequest = z.infer<typeof versionRequestSchema>;

/** A version of a source, whole: its original text, and when it was added. */
export interface SourceVersion extends SourceVersionRef {
  text: string;
  addedAt: Date;
}

/** A sweep of the store's leftovers, as of `at`. */
export const sweepRequestSchema = z.strictObject({ at: z.date() });
export type SweepRequest = z.infer<typeof sweepRequestSchema>;

/** Most dimensions of a vector. */
export const vectorDimensionsMax = 4096;

/** Most vectors one put takes. */
export const vectorsPerPutMax = 256;

/** Most chunks one vector search returns. */
export const vectorSearchLimitMax = 50;

/** Most characters of a model's name. */
export const modelNameMaxLength = 256;

const modelNameSchema = wellFormedString().min(1).max(modelNameMaxLength);

/** A vector: finite numbers, never all zero (it has no direction). */
const vectorSchema = z
  .array(z.number())
  .min(1)
  .max(vectorDimensionsMax)
  .refine((vector) => vector.some((value) => value !== 0), {
    message: "Is all zeros",
  });

/**
 * The embedding model vectors come from, as its caller names it: the
 * model and its build (`name`, one name per build, so codes of two builds
 * are never compared), and the centre its 1-bit codes are taken against,
 * shipped with the model: a vector's bit is set where it is above the
 * centre. The model's first vectors fix its centre and dimensions.
 */
export const vectorModelSchema = z.strictObject({
  name: modelNameSchema,
  centre: z.array(z.number()).min(1).max(vectorDimensionsMax),
});
export type VectorModel = z.infer<typeof vectorModelSchema>;

/** A chunk: its place in a version of a source, from 0. */
export const chunkRefSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
  position: z.int().nonnegative(),
});
export type ChunkRef = z.infer<typeof chunkRefSchema>;

/** Vectors of chunks to keep, from one model, each as long as its centre. */
export const vectorsToPutSchema = z
  .strictObject({
    model: vectorModelSchema,
    vectors: z
      .array(z.strictObject({ chunk: chunkRefSchema, vector: vectorSchema }))
      .min(1)
      .max(vectorsPerPutMax),
  })
  .refine(
    ({ model, vectors }) =>
      vectors.every(({ vector }) => vector.length === model.centre.length),
    { message: "A vector is not as long as the model's centre" }
  );
export type VectorsToPut = z.infer<typeof vectorsToPutSchema>;

/** A search by meaning: a model's vector of the question, and the reader. */
export const vectorSearchSchema = z.strictObject({
  model: modelNameSchema,
  vector: vectorSchema,
  reader: readerSchema,
  limit: z.int().min(1).max(vectorSearchLimitMax),
});
export type VectorSearch = z.infer<typeof vectorSearchSchema>;

/** A chunk a vector search found, and how near it is: its cosine, -1 to 1. */
export interface FoundChunk extends ChunkRef {
  score: number;
}

/** What a vector search found the reader may read, nearest first. */
export interface VectorsFound {
  chunks: FoundChunk[];
}

/** The Brain, as its host calls it. */
export interface Brain {
  /**
   * Adds the change `source.change` to `source.source` as a version with
   * this text, readable as its access says, and makes it the source's
   * current one. In this order: a change added before answers with the
   * version it made, whatever was added since, and is refused with other
   * text or readers; a new change with the same text and readers as the
   * current version is that version. So an add is safe to repeat, late
   * or at once, after a lost reply or a crash.
   */
  addSource: (source: NewSource) => Promise<SourceVersionRef>;
  /**
   * The chunks of current versions the reader may read that hold the
   * question's words, best first: those holding more of them, then
   * shorter, then newer.
   */
  recall: (request: RecallRequest) => Promise<Recalled>;
  /**
   * A version of a source, current or history, whole as it was added, for
   * a reader among that version's readers and the source's current
   * version's, with the groups the host counts them in now: `null` when
   * there is none or they may not, alike. So narrowing a source's readers
   * hides its history from those taken off.
   */
  readVersion: (request: VersionRequest) => Promise<SourceVersion | null>;
  /**
   * Removes what an add that never finished left: files no version holds,
   * once past the time an add takes. Harmless to run late or twice.
   */
  sweep: (request: SweepRequest) => Promise<void>;
  /**
   * Keeps each vector as the codes of its chunk for `model`, readable as
   * the chunk's version is. A chunk that is not of a current version is
   * left out, so a late put never brings back what a newer version
   * replaced. Codes are written once per chunk and model name: a chunk
   * that already holds codes for the model keeps them, so a put is safe
   * to repeat, and a wrong vector stays until the chunk's next version,
   * so a model's every build needs a name of its own. Refused when the
   * model's name is known with another centre. For the Brain's own work
   * queue (GRA-1768): the host has no way to it.
   */
  putVectors: (request: VectorsToPut) => Promise<void>;
  /**
   * The chunks of current versions the reader may read whose codes for
   * the model are nearest the vector, nearest first, none for a model
   * with no codes: an exact 1-bit scan of every such code, then the
   * nearest candidates re-scored by cosine, so a chunk near the top by
   * cosine whose 1-bit code is not among the candidates is missed. For
   * recall (GRA-1769): the host has no way to it.
   */
  searchVectors: (request: VectorSearch) => Promise<VectorsFound>;
  /**
   * Repacks one block of codes that holds removed ones, dropping them for
   * good: true when more are left. Harmless to run at any time or twice;
   * for the work queue (GRA-1724) and erasure (GRA-1729).
   */
  repackVectors: () => Promise<boolean>;
}

/** The one store's name: the Brain holds everything in one store for now. */
const storeName = "brain";

/**
 * The Brain, in `store`, the host's namespace of `BrainStore`, in the
 * jurisdiction the host keeps its objects in.
 */
export const brainOf = (store: DurableObjectNamespace<BrainStore>): Brain =>
  store.getByName(storeName);
