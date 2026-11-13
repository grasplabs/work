import type { AppVersion, FileDiff } from "./apps.ts";
import { defineErrorFamily } from "./errors.ts";
import type { SubscriptionApi } from "./pages.ts";
import type { Subject } from "./subject.ts";
import type { WorkflowResourceVersion } from "./workflow-resources.ts";

// The draft of an App or a workflow (core's drafts.ts): one per subject,
// shared by everyone who builds it and by their chats' agents. Every
// write lands over the revision it read, so a stale one is refused
// (`draft.conflict`) and rereads; each agent turn and each person's edit
// keeps a checkpoint to step back to. Only a person publishes a draft as
// the subject's next version (core's publish.ts); a version is rolled
// back to the same way. A workflow's draft is one file, `workflow.json`.

/** A subject's draft as it is now (`DraftsApi.get`). */
export interface Draft {
  subject: Subject;
  /** The version it is over; null for one with no version yet. */
  base: number | null;
  /** The paths it changes, sorted. */
  changed: string[];
  /** Those of `changed` it deletes, sorted: nothing to open or preview. */
  deleted: string[];
  /**
   * Whether it changes an App's definition: a change of its stable IDs
   * alone changes no file, yet is a change of the App all the same.
   * Always false for a workflow.
   */
  definitionChanged: boolean;
  /** Which write of the draft this is (0: none yet): anything read at an earlier one is out of date. */
  revision: number;
  /** When it was last written (ISO 8601); null before its first write. */
  updatedAt: string | null;
  /** Who wrote it last, themselves or through their chat's agent; null before its first write. */
  updatedBy: string | null;
}

/**
 * One checkpoint of a draft (`DraftsApi.checkpoints`): the draft as one
 * agent turn left it, as one person's edit left it, or as a restore,
 * discard, publish or roll back made it. The newest follows its turn's
 * writes while the turn runs, then never changes; it is restored only as
 * a new one.
 */
export interface DraftCheckpoint {
  /** Its place among the draft's checkpoints, from 1, in the order they landed. */
  number: number;
  /** The draft's revision it made. */
  revision: number;
  /** The version it is over; null for one with no version yet. */
  base: number | null;
  /** The SHA-256 of what it holds: two checkpoints alike hold the same. */
  contentHash: string;
  /** Who wrote it: the person, themselves or through their chat's agent. */
  personId: string;
  /** The chat whose agent wrote it; null for a person's own edit or restore. */
  chatId: string | null;
  /**
   * The code step or tool call (`ChatCode.callId`, `ChatToolCall.callId`)
   * that wrote it last, when a chat's agent did.
   */
  callId: string | null;
  /** The checkpoint the person restored as this one, if they did. */
  restoredFrom: number | null;
  /** When it was written (ISO 8601). */
  createdAt: string;
  /** The paths it changed against the checkpoint before it, sorted. */
  touched: string[];
  /**
   * How many paths it changes over its base: none for the draft as a
   * publish or roll back left it, the version it is over.
   */
  changes: number;
}

/** A version a publish or roll back made live (`DraftsApi.publish`). */
export interface LiveVersion {
  subject: Subject;
  version: number;
  /** What people call it, `YY.MM.N`, kept from when it first went live. */
  label: string;
}

/**
 * The drafts of Apps and workflows, for their builders (`drafts`): read
 * one, step back to a checkpoint, discard it, follow it and publish it.
 * Writing one is the subject's own (an App's files and definition, a
 * workflow's editor) or a chat's agent's.
 */
export interface DraftsApi {
  /** The subject's draft now. */
  get: (subject: Subject) => Promise<Draft>;
  /**
   * Every file of the draft as it is now: its changes over the version it
   * is over, or that version's files while it changes nothing. Read-only.
   */
  files: (subject: Subject) => Promise<Record<string, string>>;
  /**
   * The draft's checkpoints, newest first, with what each touched: the
   * newest page, or the page before checkpoint `before`.
   */
  checkpoints: (
    subject: Subject,
    before?: number
  ) => Promise<DraftCheckpoint[]>;
  /**
   * Makes checkpoint `checkpoint` the draft again, as a new checkpoint;
   * refused with `draft.conflict` when the draft moved since `revision`,
   * which the person read.
   */
  restore: (
    subject: Subject,
    checkpoint: number,
    revision: number
  ) => Promise<DraftCheckpoint>;
  /**
   * Discards the draft's changes; its checkpoints stay, to restore one.
   * Refused with `draft.conflict` when the draft moved since `revision`.
   */
  discard: (subject: Subject, revision: number) => Promise<void>;
  /**
   * Follows the draft: `onRevision` hears its revision after each write,
   * whoever made it, until the hold is released or the person no longer
   * builds the subject.
   */
  watch: (
    subject: Subject,
    onRevision: (revision: number) => void
  ) => Promise<SubscriptionApi>;
  /**
   * Publishes the draft at `revision`, the one the person read, as the
   * subject's next version, built, checked and made live in one step, as
   * the person; the draft is then empty over it. Refused with
   * `draft.conflict` when the draft moved since `revision` or another
   * version went live meanwhile, `draft.empty` when it changes nothing,
   * and with the refusal of its check or build (an App's
   * `app.draft_failed`, a workflow's `workflow.definition_invalid`). A
   * workflow's runs keep the version they started on; its triggers start
   * the new one. Not for an archived App or a deleted
   * workflow.
   */
  publish: (subject: Subject, revision: number) => Promise<LiveVersion>;
}

/**
 * A subject's version, as its kind has it: an App's or a workflow's, told
 * apart by its `kind`. Not narrowed by the subject's kind in the API's
 * types: a generic method's types don't survive an RPC stub.
 */
export type Version = AppVersion | WorkflowResourceVersion;

/**
 * The versions of Apps and workflows (`versions`), for their builders:
 * list and compare them, and roll back to one.
 */
export interface VersionsApi {
  /** The subject's versions, newest first, a page at a time. */
  list: (subject: Subject, before?: number) => Promise<Version[]>;
  get: (subject: Subject, version: number) => Promise<Version>;
  /** Every file of `version`, exactly as published. */
  files: (subject: Subject, version: number) => Promise<Record<string, string>>;
  /** How the files of version `to` differ from those of `from`, by path. */
  diff: (subject: Subject, from: number, to: number) => Promise<FileDiff[]>;
  /**
   * Makes `version` live again, to roll back to it. The draft moves onto
   * it, its unpublished changes discarded, only over `revision`, the
   * draft's revision the person read (`draft.conflict` once it moved, or
   * when it has changes and none was given); and only over `expected`,
   * when given, the version they saw live. A workflow's triggers start it
   * from then on.
   */
  rollback: (
    subject: Subject,
    version: number,
    revision?: number,
    expected?: number | null
  ) => Promise<LiveVersion>;
}

/** Why a call to a draft or a version was refused. */
export const draftErrors = defineErrorFamily({
  "draft.invalid": "That isn't a valid request for a draft.",
  "draft.conflict":
    "Someone else changed the draft at the same time. Read it again and retry.",
  "draft.empty": "The draft has no changes to publish.",
  "draft.checkpoint_not_found": "The draft has no such checkpoint.",
});
