import { z } from "zod";

import type { BrainStore } from "./store.ts";

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

/** Most bytes of a source's text (UTF-8). */
export const sourceTextMaxBytes = 1_000_000;

/** Most characters of a question. */
export const questionMaxLength = 2000;

/** Most groups a reader can be in. */
export const readerGroupsMax = 1000;

/** Most characters of a principal's ID. */
export const principalMaxLength = 256;

/** Most chunks one recall returns. */
export const recallLimit = 10;

/** Most characters of a source's identity. */
export const sourceIdMaxLength = 256;

const principalSchema = z.string().min(1).max(principalMaxLength);

/**
 * A source's identity, given by its producer (this upload, this chat): the
 * same for every version of it, so a new version of the same thing is
 * added under the same identity.
 */
export const sourceIdSchema = z.string().min(1).max(sourceIdMaxLength);
export type SourceId = z.infer<typeof sourceIdSchema>;

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
 * A version of a source to add: which source, its text, and who may read
 * this version.
 */
export const newSourceSchema = z.strictObject({
  source: sourceIdSchema,
  text: z
    .string()
    .min(1)
    .refine(
      (text) => new TextEncoder().encode(text).byteLength <= sourceTextMaxBytes,
      { message: `At most ${sourceTextMaxBytes} bytes` }
    ),
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
  question: z.string().max(questionMaxLength),
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

/** The Brain, as its host calls it. */
export interface Brain {
  /**
   * Adds a version of `source.source` with this text, readable as its
   * access says, and makes it the source's current one. The same text
   * and readers as the current version add nothing and answer with that
   * version, so an add is safe to repeat after a lost reply.
   */
  addSource: (source: NewSource) => Promise<SourceVersionRef>;
  /**
   * The chunks of current versions the reader may read that hold the
   * question's words, best first: those holding more of them, then
   * shorter, then newer.
   */
  recall: (request: RecallRequest) => Promise<Recalled>;
  /**
   * A version of a source, current or history, whole as it was added:
   * `null` when there is none or the reader may not read it, alike.
   */
  readVersion: (request: VersionRequest) => Promise<SourceVersion | null>;
}

/** The one store's name: the Brain holds everything in one store for now. */
const storeName = "brain";

/**
 * The Brain, in `store`, the host's namespace of `BrainStore`, in the
 * jurisdiction the host keeps its objects in.
 */
export const brainOf = (store: DurableObjectNamespace<BrainStore>): Brain =>
  store.getByName(storeName);
