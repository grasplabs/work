import { draftErrors } from "@grasp-os/shared/drafts";
import type {
  DraftCheck,
  DraftProblem,
  LiveVersion,
} from "@grasp-os/shared/drafts";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { subjectSchema } from "@grasp-os/shared/subject";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appSteps } from "./app-publish.ts";
import { appKind } from "./apps.ts";
import {
  changesAnything,
  draftOf,
  draftRevised,
  emptyDraftStatements,
  emptyDraft,
  filesOf,
  rebaseDraft,
  rebasedOnto,
} from "./drafts.ts";
import type { DraftKind, DraftState } from "./drafts.ts";
import { workflowSteps } from "./workflow-publish.ts";
import { workflowKind } from "./workflow-resources.ts";

// Publishing an App's or a workflow's draft, and rolling back to one of
// its versions (GRA-1665): one step each, run by one of its builders as
// themselves, never by a chat's agent. The steps every kind shares are
// here: the draft is published only at the revision the builder read,
// only when it changes something, checked and built as the next version,
// and made live over the version live when the publish began, the draft
// emptied over it in the batch that makes it live. Each kind is defined
// the same way: what drafts and versions read of it (its `DraftKind`, in
// apps.ts and workflow-resources.ts) and how a draft of it is built and
// made live (its `PublishSteps`, in app-publish.ts and
// workflow-publish.ts), both registered here (`kinds`, `steps`). A version takes its label
// (`YY.MM.N`) only in the batch that first makes it live, so a publish
// that fails takes none.
//
// Threat model: what goes live is exactly what the builder saw, and
// nothing they didn't see is lost. How each way it could fail is closed:
//
// - A publish over a draft the builder never saw: refused once the draft
//   moved past the revision they read (`draft.conflict`), checked as it
//   is, and emptied over the new version in the batch that makes it live
//   (drafts.ts, `emptyDraftStatements`), so it never keeps changes the live
//   version has. A write that landed meanwhile keeps the draft as it is,
//   over the version it read, and the publish then moves it onto the
//   version live (`rebaseDraft`), so that write is neither lost nor a
//   dead end. A draft left over an older version is published as it
//   reads (`rebasedOnto`), so nothing discarded, rolled back or failed
//   comes back.
// - Two publishes at once: each makes its version live only over the
//   version live when it began (its kind's `activate`, compared and set
//   in the statement that does it); the other is `draft.conflict`.
// - A roll back over unseen changes: it discards the draft's changes
//   only over the revision the builder read. A write that lands after
//   that, before the batch that makes the version live, is discarded with
//   them in that batch, audited, its own checkpoint kept to restore: the
//   roll back never fails once an App's store took the version's schema,
//   and a draft over the newer version would carry all of it back as its
//   own changes.
// - A batch whose answer was lost, tried again (`retriedBatch`): the
//   draft's statements hold again for the write they made, so the retry
//   is answered as the publish or roll back it is (drafts.ts,
//   `emptyDraftStatements`), and the draft's followers are told
//   (`draftRevised`).

/** How a kind publishes a draft (`steps`). */
export interface PublishSteps {
  /**
   * Checks `draft` of subject `id`, its files `files`, for `by`, as
   * building it checks it, building nothing: whether it passes, and the
   * errors it found.
   */
  check: (
    env: Env,
    by: Identity,
    id: string,
    checked: { draft: DraftState; files: Map<string, string> }
  ) => Promise<{ passed: boolean; problems: DraftProblem[] }>;
  /**
   * Makes `draft` the subject's next version, its files `files`, checked
   * and built as its kind builds one: its number. A version whose check
   * or build fails is never made live, and the failure is thrown.
   */
  build: (
    env: Env,
    by: Identity,
    id: string,
    built: { draft: DraftState; files: Map<string, string> }
  ) => Promise<number>;
  /**
   * Makes `version` live over `basedOn` (null for none), audited as
   * `action`, with `alongside` in the batch that does and only if it
   * does, building it first if it never was: its label. A version live
   * already is answered as it is. `draft.conflict` once another version
   * went live since `basedOn`.
   */
  activate: (
    env: Env,
    by: Identity,
    id: string,
    activated: {
      version: number;
      basedOn: number | null;
      action: "version.published" | "version.rolled_back";
      alongside: (live: SQL) => Promise<BatchItem<"sqlite">[]>;
    }
  ) => Promise<string>;
}

/** Each kind of subject, as drafts and versions see it. */
export const kinds: Readonly<Record<SubjectKind, DraftKind>> = {
  app: appKind,
  workflow: workflowKind,
};

/** How each kind publishes a draft and makes a version live. */
const steps: Readonly<Record<SubjectKind, PublishSteps>> = {
  app: appSteps,
  workflow: workflowSteps,
};

/** The subject a caller names, as they sent it. */
export const subjectOf = (subject: unknown): Subject =>
  draftErrors.parse("draft.invalid", subjectSchema, subject);

/** A version number as a caller sends it. */
const versionSchema = z.int().min(1);

/** What a caller may expect is live: a version, or null for none. */
const expectedSchema = versionSchema.nullable();

/** Most problems a draft's check lists. */
const maxProblems = 50;

/**
 * The draft of the subject `input` names, checked for `by`, who builds it,
 * as publishing checks it (its kind's `check`), at the revision read.
 */
export const check = async (
  env: Env,
  kind: DraftKind,
  by: Identity,
  input: unknown
): Promise<DraftCheck> => {
  const id = await kind.readable(env, by, input);
  const draft = await draftOf(env, kind, id);
  const files = await filesOf(env, kind, id, draft);
  const { passed, problems } = await steps[kind.kind].check(env, by, id, {
    draft,
    files,
  });
  return {
    revision: draft.revision,
    passed,
    problems: problems.slice(0, maxProblems),
  };
};

/** Nothing besides, in the batch that makes a version live. */
const nothing = async (): Promise<BatchItem<"sqlite">[]> =>
  await Promise.resolve([]);

/**
 * Publishes the draft of the subject `input` names, at `revision`, the
 * one `by` read, for `by`, who may write it (`DraftKind.editable`):
 * checked, built as its next version and made live over the version live
 * now, the draft emptied over it with the batch that does. Refused with
 * `draft.conflict` once the draft moved past `revision` or another
 * version went live, `draft.empty` when it changes nothing, and as its
 * kind's build refuses it, with nothing made live. A draft left over an
 * older version that holds nothing the live one hasn't is emptied, and
 * the live version answered.
 */
export const publish = async (
  env: Env,
  kind: DraftKind,
  by: Identity,
  input: unknown,
  revision: number
): Promise<LiveVersion> => {
  const id = await kind.editable(env, by, input);
  const subject = { kind: kind.kind, id };
  const read = await draftOf(env, kind, id);
  if (read.revision !== revision) {
    throw draftErrors.create("draft.conflict");
  }
  const basedOn = await kind.currentVersion(env, id);
  const liveBase = await kind.liveBase(env, id);
  // A draft left over an older version (written while a publish went
  // live, or restored from before one) is published as it reads, over the
  // version live: never a dead end, nothing of it lost.
  const draft = await rebasedOnto(env, kind, id, read, liveBase);
  if (!changesAnything(draft)) {
    if (!changesAnything(read)) {
      throw draftErrors.create("draft.empty");
    }
    // What it holds is live already: nothing is left to publish, and its
    // changes over the older version go.
    await emptyDraft(env, kind, id, { revision, base: liveBase, by });
    if (basedOn === null) {
      throw draftErrors.create("draft.empty");
    }
    const label = await steps[kind.kind].activate(env, by, id, {
      version: basedOn,
      basedOn,
      action: "version.published",
      alongside: nothing,
    });
    return { subject, version: basedOn, label };
  }
  const files = await filesOf(env, kind, id, draft);
  const version = await steps[kind.kind].build(env, by, id, { draft, files });
  const at = new Date();
  const label = await steps[kind.kind].activate(env, by, id, {
    version,
    basedOn,
    action: "version.published",
    alongside: async (live) =>
      await emptyDraftStatements(
        drizzle(env.DB),
        subject,
        { revision: draft.revision, base: version, by, at, rollsBack: false },
        live
      ),
  });
  await draftRevised(env, subject);
  // A write that landed meanwhile left the draft over the version before.
  // Only tidying once the version is live: whatever stops it (the subject
  // archived, the role taken away, D1 failing) never says the publish
  // failed, and the next publish rebases a stale draft all the same.
  try {
    await rebaseDraft(env, kind, id, by);
  } catch (error) {
    log.warn("draft.rebase_failed", {
      ...subject,
      version,
      ...errorFields(error),
    });
  }
  return { subject, version, label };
};

/**
 * Makes `versionInput` of the subject `input` names live again, for `by`,
 * who may write its draft: built first unless it is, then made live over
 * the version live now, or over `expected` when the caller says what it
 * expects is live (`draft.conflict` when it isn't). The draft moves onto
 * it, its unpublished changes discarded, audited, with the batch that
 * makes it live: what a builder confirms rolling back, over `revision`,
 * the draft's revision they read (`draft.conflict` once it moved since,
 * or when it has changes and none was given). A write that lands after
 * that is discarded with them (drafts.ts, `emptyDraftStatements`). A
 * version live already only resets the draft.
 */
export const rollback = async (
  env: Env,
  kind: DraftKind,
  by: Identity,
  input: unknown,
  versionInput: unknown,
  revision?: unknown,
  expected?: unknown
): Promise<LiveVersion> => {
  const id = await kind.editable(env, by, input);
  const subject = { kind: kind.kind, id };
  const version = draftErrors.parse(
    "draft.invalid",
    versionSchema,
    versionInput
  );
  const draft = await draftOf(env, kind, id);
  // Unpublished changes go only over the revision the builder read: never
  // unseen.
  if (
    (changesAnything(draft) || revision !== undefined) &&
    revision !== draft.revision
  ) {
    throw draftErrors.create("draft.conflict");
  }
  const resets = changesAnything(draft) || draft.base !== version;
  const current = await kind.currentVersion(env, id);
  if (current === version) {
    if (resets) {
      await emptyDraft(env, kind, id, {
        revision: draft.revision,
        base: version,
        by,
        live: true,
      });
    }
    const label = await steps[kind.kind].activate(env, by, id, {
      version,
      basedOn: current,
      action: "version.rolled_back",
      alongside: nothing,
    });
    return { subject, version, label };
  }
  const basedOn =
    expected === undefined
      ? current
      : draftErrors.parse("draft.invalid", expectedSchema, expected);
  if (basedOn !== current) {
    throw draftErrors.create("draft.conflict");
  }
  const at = new Date();
  const label = await steps[kind.kind].activate(env, by, id, {
    version,
    basedOn,
    action: "version.rolled_back",
    alongside: resets
      ? async (live) =>
          await emptyDraftStatements(
            drizzle(env.DB),
            subject,
            {
              revision: draft.revision,
              base: version,
              by,
              at,
              rollsBack: true,
            },
            live
          )
      : nothing,
  });
  // Told even when no row of the draft changed: a draft with no changes
  // reads as over the version live, so its builders' open pages follow
  // the version that went live.
  await draftRevised(env, subject);
  return { subject, version, label };
};
