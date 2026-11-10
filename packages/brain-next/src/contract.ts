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

/** Most sources one recall returns. */
export const recallLimit = 10;

const principalSchema = z.string().min(1).max(principalMaxLength);

/** A source, as the Brain names it. */
export const sourceIdSchema = z.string().min(1).max(64).brand<"SourceId">();
export type SourceId = z.infer<typeof sourceIdSchema>;

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

/** A source to add: its text, and who may read it. */
export const newSourceSchema = z.strictObject({
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

/** A source a recall found. */
export interface RecalledSource {
  id: SourceId;
  text: string;
}

/** What a recall found the reader may read, best first. */
export interface Recalled {
  sources: RecalledSource[];
}

/** The Brain, as its host calls it. */
export interface Brain {
  /** Adds `source`, readable as its access says. */
  addSource: (source: NewSource) => Promise<{ id: SourceId }>;
  /**
   * The sources the reader may read that hold the question's words, best
   * first: those holding more of them, then shorter, then newer.
   */
  recall: (request: RecallRequest) => Promise<Recalled>;
}

/** The one store's name: the Brain holds everything in one store for now. */
const storeName = "brain";

/**
 * The Brain, in `store`, the host's namespace of `BrainStore`, in the
 * jurisdiction the host keeps its objects in.
 */
export const brainOf = (store: DurableObjectNamespace<BrainStore>): Brain =>
  store.getByName(storeName);
