import { draftErrors } from "@grasp-os/shared/drafts";
import type { LiveVersion } from "@grasp-os/shared/drafts";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { notNullFailed } from "./db/d1.ts";
import {
  changesAnything,
  draftOf,
  draftRevised,
  emptiedWithLive,
  emptyDraft,
  filesOf,
  rebaseDraft,
  rebasedOnto,
} from "./drafts.ts";
import type { DraftKind, DraftState } from "./drafts.ts";

// Publishing an App's or a workflow's draft, and rolling back to one of
// its versions (GRA-1665): one step each, run by one of its builders as
// themselves, never by a chat's agent. The steps every kind shares are
// here: the draft is published only at the revision the builder read,
// only when it changes something, checked, built as the next version,
// and made live over the version live when the publish began, the draft
// emptied over it in the batch that makes it live. What differs by kind
// (how a draft is checked, built and made live) is its `PublishSteps`
// (app-publish.ts, workflow-publish.ts). A version takes its label
// (`YY.MM.N`) only in the batch that first makes it live, so a publish
// that fails takes none.
//
// Threat model: what goes live is exactly what the builder saw, and
// nothing they didn't see is lost. How each way it could fail is closed:
//
// - A publish over a draft the builder never saw: refused once the draft
//   moved past the revision they read (`draft.conflict`), checked as it
//   is, and emptied over the new version in the batch that makes it live
//   (drafts.ts, `emptiedWithLive`), so it never keeps changes the live
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
//   only over the revision the builder read, in the batch that makes the
//   version live, and a write meanwhile fails that batch
//   (`draft.conflict`), as a draft over the newer version would carry all
//   of it back as its own changes.
// - A batch whose answer was lost, tried again (`retriedBatch`): the
//   draft's statements hold again for the write they made, so the retry
//   is answered as the publish or roll back it is (drafts.ts,
//   `emptiedWithLive`), and the draft's followers are told
//   (`draftRevised`).

/** What a kind does at each step of a publish (app-publish.ts, workflow-publish.ts). */
export interface PublishSteps {
  /**
   * Refuses `draft` of subject `id`, whose files are `files`, when it may
   * not be published as it is: its kind's checks.
   */
  check: (
    env: Env,
    by: Identity,
    id: string,
    draft: DraftState,
    files: Map<string, string>
  ) => Promise<void>;
  /**
   * Makes `draft` the subject's next version, with `message`, built and
   * checked as its kind builds one: its number. A version whose build
   * fails is marked so, and never made live; the failure is thrown.
   */
  build: (
    env: Env,
    by: Identity,
    id: string,
    built: { draft: DraftState; files: Map<string, string>; message: string }
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

/** A kind of subject: its draft and its publish. */
export interface Publishable {
  draft: DraftKind;
  steps: PublishSteps;
}

/** A version number as a caller sends it. */
const versionSchema = z.int().min(1);

/** What a caller may expect is live: a version, or null for none. */
const expectedSchema = versionSchema.nullable();

/** Nothing besides, in the batch that makes a version live. */
const nothing = async (): Promise<BatchItem<"sqlite">[]> =>
  await Promise.resolve([]);

/**
 * Publishes the draft of the subject `input` names, at `revision`, the
 * one `by` read, for `by`, who may write it (`DraftKind.editable`), with
 * `message`: checked, built as its next version and made live over the
 * version live now, the draft emptied over it with the batch that does.
 * Refused with `draft.conflict` once the draft moved past `revision` or
 * another version went live, `draft.empty` when it changes nothing, and as
 * its kind's check refuses it, with nothing built.
 */
export const publish = async (
  env: Env,
  { draft: kind, steps }: Publishable,
  by: Identity,
  input: unknown,
  revision: number,
  message: string
): Promise<LiveVersion> => {
  const id = await kind.editable(env, by, input);
  const subject = { kind: kind.kind, id };
  const read = await draftOf(env, kind, id);
  if (read.revision !== revision) {
    throw draftErrors.create("draft.conflict");
  }
  const basedOn = await kind.liveVersion(env, id);
  // A draft left over an older version (written while a publish went
  // live, or restored from before one) is published as it reads, over the
  // version live: never a dead end, nothing of it lost.
  const draft = await rebasedOnto(
    env,
    kind,
    id,
    read,
    await kind.liveBase(env, id)
  );
  if (!changesAnything(draft)) {
    throw draftErrors.create("draft.empty");
  }
  const files = await filesOf(env, kind, id, draft);
  await steps.check(env, by, id, draft, files);
  const version = await steps.build(env, by, id, { draft, files, message });
  const at = new Date();
  const label = await steps.activate(env, by, id, {
    version,
    basedOn,
    action: "version.published",
    alongside: async (live) =>
      await emptiedWithLive(
        drizzle(env.DB),
        subject,
        {
          revision: draft.revision,
          base: version,
          by,
          at,
          rollsBack: false,
          discards: false,
        },
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
 * or when it has changes and none was given), and only while the draft is
 * still at the revision read here (`draft.conflict` for a write
 * meanwhile). A version live already only resets the draft.
 */
export const rollback = async (
  env: Env,
  { draft: kind, steps }: Publishable,
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
  const discards = changesAnything(draft);
  // Unpublished changes go only over the revision the builder read: never
  // unseen.
  if ((discards || revision !== undefined) && revision !== draft.revision) {
    throw draftErrors.create("draft.conflict");
  }
  const resets = discards || draft.base !== version;
  const current = await kind.liveVersion(env, id);
  if (current === version) {
    if (resets) {
      await emptyDraft(env, kind, id, {
        revision: draft.revision,
        base: version,
        by,
        live: true,
      });
    }
    const label = await steps.activate(env, by, id, {
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
  let label: string;
  try {
    label = await steps.activate(env, by, id, {
      version,
      basedOn,
      action: "version.rolled_back",
      alongside: resets
        ? async (live) =>
            await emptiedWithLive(
              drizzle(env.DB),
              subject,
              {
                revision: draft.revision,
                base: version,
                by,
                at,
                rollsBack: true,
                discards,
              },
              live
            )
        : nothing,
    });
  } catch (error) {
    // The draft moved since it was read: rolled back over nothing.
    if (notNullFailed(error, "drafts.revision")) {
      throw draftErrors.create("draft.conflict");
    }
    throw error;
  }
  // Told even when no row of the draft changed: a draft with no changes
  // reads as over the version live, so its builders' open pages follow
  // the version that went live.
  await draftRevised(env, subject);
  return { subject, version, label };
};
