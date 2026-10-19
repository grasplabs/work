import {
  contractFingerprint,
  preferenceOperations,
  preferencePaths,
  schemaFromDescriptor,
} from "@grasp-os/sdk/host";
import type { PreferenceOperationName } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import { dataErrors } from "@grasp-os/shared/stores";
import {
  idempotencyKeySchema,
  submissionErrors,
} from "@grasp-os/shared/submissions";

import type { Release } from "./app-releases.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { preferencesWatch } from "./store-host.ts";
import type { StoredPreferences } from "./store-host.ts";

// An App's preferences (spec 10.7.7): `preferences.get` and
// `preferences.update`, which the SDK declares (preference-operations.ts)
// and generates into `#grasp` as public function references. They aren't
// the App's functions: core answers them itself, as it answers workflow
// references' queries (workflow-reference-queries.ts), from the App's own
// business store, where they sit in a host-owned table no App code reaches
// (`sdk_preferences`, store-host.ts). Threat model (also on GRA-760), and
// how each is closed:
//
// - Another person's preferences: whose they are is the caller's user ID
//   from the session, passed by core and never read from the call. The
//   arguments are strict objects with no person in them, so naming one is
//   refused as any unknown key. No role reads another's, an admin's
//   neither.
// - A reference made up, or of another App, release or contract: it
//   resolves only against the App's current sealed release and the
//   preferences it declares, rebuilt here, and must name exactly that
//   release, kind and fingerprint. An App that declares none has none.
//   No function of the App's shadows them: the SDK keeps the top-level
//   `preferences` segment for the platform.
// - Keys, values or sizes the App didn't declare: a patch is the strict,
//   all-optional form of the declared object, checked by the native
//   validator; the document it makes is checked whole by the declared
//   object again before it is written, and the store bounds its size.
//   Every preference has a default (the SDK refuses one without), so a
//   document is always whole.
// - Lost updates: `update` names the revision it read; the store writes
//   the next one only while that is still the current one, in one
//   transaction (`data.conflict` otherwise). A patch that changes nothing
//   writes nothing and keeps the revision.
// - A save whose answer was lost, sent again: an `update` under an
//   idempotency key keeps the key, its input's hash and its answer with
//   the person's row; a resend of that write answers that answer, never a
//   conflict with itself, and the same key with another input is refused
//   (`submission.key_conflict`), as is a resend under another release,
//   whose answer would have another shape. Only the last write's key is
//   kept: a resend after a later write conflicts on its revision instead.
// - Access lost mid-call: the caller's gate (their own check, an agent's
//   grant say; the release not revoked; the person's role read again; the
//   deadline) runs before the store is read, and again right before it is
//   written. A live `get` is read again through the screen's
//   subscription, which lets go once access goes.
// - Activity leaked through live reads, or one person spending everyone's
//   budget for them: a live `get` watches its own person's revision only
//   (`preferencesWatch`), so a write tells the reads of the person who
//   made it and nobody else's.
// - Stored preferences that no longer fit the App's (a later version
//   changed them): only what the person chose is stored, never a default,
//   so a field they never set is answered with the default in force. A
//   stored key the App no longer declares is left out of the answer and
//   kept until the person next writes, which drops it: going back to a
//   version with it finds it until then, and the document never grows
//   with what earlier versions declared. A declared field whose stored
//   value no longer fits is refused (`data.incompatible_record`), never
//   coerced or rewritten; a patch that replaces it is taken.
//
// Audit: like a write of the App's own records, a preference write isn't
// audited one by one; an agent's call of either is audited as
// `agent.call`, and a
// chat's agent may read or change its person's own preferences under its
// grant on the App (`read` for `get`, `write` for `update`). Erasing a
// person's preferences belongs to person erasure, as their records do.

const pathPattern = /^preferences\.(?<name>get|update)$/u;

/** Whether `contractId` names one of an App's preference operations. */
export const isPreferencePath = (contractId: string): boolean =>
  pathPattern.test(contractId);

/** A preference operation a reference resolved to, in a release. */
export interface ResolvedPreferenceOperation {
  readonly name: PreferenceOperationName;
  /** The App's preferences: what a document is checked by. */
  readonly preferences: unknown;
  readonly args: unknown;
  readonly returns: unknown;
  /** Its exact contract's fingerprint, which the reference named. */
  readonly fingerprint: string;
}

/**
 * The preference operation `reference` names in `release`, checked as a
 * function reference is: one the release generates, of its exact App and
 * version, kind and fingerprint (`operation.not_found`,
 * `operation.kind_mismatch`, `version.mismatch`).
 */
export const preferenceOperationOf = async (
  release: Release,
  reference: {
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly contractId: string;
    readonly fingerprint: string;
    readonly kind: string;
  }
): Promise<ResolvedPreferenceOperation> => {
  const declared = release.app.preferences;
  const name = pathPattern.exec(reference.contractId)?.groups?.name;
  if (declared === null || (name !== "get" && name !== "update")) {
    throw operationErrors.create("operation.not_found");
  }
  const operation = preferenceOperations(declared)[name];
  if (operation.path !== preferencePaths[name]) {
    throw operationErrors.create("operation.not_found");
  }
  if (reference.kind !== operation.kind) {
    throw operationErrors.create("operation.kind_mismatch");
  }
  const fingerprint = await contractFingerprint(operation);
  if (
    reference.resourceId !== release.manifest.resourceId ||
    reference.resourceVersion !== release.manifest.resourceVersion ||
    reference.fingerprint !== fingerprint
  ) {
    throw versionErrors.create("version.mismatch");
  }
  return {
    name,
    preferences: declared,
    args: operation.args,
    returns: operation.returns,
    fingerprint,
  };
};

/** `value` checked by `descriptor`, normalized, or what `refusal` makes. */
const checked = (
  descriptor: unknown,
  value: unknown,
  refusal: () => Error
): Record<string, Json> => {
  const result = schemaFromDescriptor(JSON.stringify(descriptor))[
    "~standard"
  ].validate(value);
  if (result.issues !== undefined) {
    throw refusal();
  }
  const normalized: unknown = result.value;
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized)
  ) {
    throw refusal();
  }
  // SAFETY: what an object descriptor admits is a JSON object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return normalized as Record<string, Json>;
};

/** Who calls, through which App's release, and what they may still do. */
export interface PreferencesCaller {
  /** The signed-in person: whose preferences, always. */
  readonly userId: string;
  readonly release: Release;
  /**
   * Runs before the store is read or written: the caller's own check,
   * the release not revoked, the person's role read again, the deadline.
   */
  readonly gate: () => Promise<void>;
  /** Told the store a `get` read and the generation it read it at. */
  readonly observeReads?: (
    storeId: StoreId,
    readSet: Record<string, number>
  ) => void;
}

/** The store of `release`, which an App with preferences always has. */
const storeOfRelease = (env: Env, release: Release) => {
  if (release.store === null) {
    throw versionErrors.create("version.store_unbound");
  }
  const storeId = storeIdSchema.parse(release.store.storeId);
  return {
    storeId,
    stub: inJurisdiction(env, env.DATA_STORES).getByName(storeId),
  };
};

/** Whether `value` is a JSON object. */
const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The names of the fields `preferences` declares. */
const declaredNames = (preferences: unknown): ReadonlySet<string> =>
  new Set(
    isObject(preferences) && isObject(preferences.fields)
      ? Object.keys(preferences.fields)
      : []
  );

/** `chosen` checked by the App's preferences now: what the person has. */
const effectiveOf = (
  operation: ResolvedPreferenceOperation,
  chosen: Record<string, Json>,
  refusal: () => Error
): Record<string, Json> => {
  // A key the App no longer declares (a later version removed it, or the
  // App went back to one without it) is left out here and kept as stored:
  // a version that declares it again finds it.
  const declared = declaredNames(operation.preferences);
  return checked(
    operation.preferences,
    Object.fromEntries(
      Object.entries(chosen).filter(([name]) => declared.has(name))
    ),
    refusal
  );
};

/** What the person chose, as stored: only the fields they set. */
const chosenOf = (stored: StoredPreferences): Record<string, Json> => {
  if (stored.valueJson === null) {
    return {};
  }
  let chosen: unknown;
  try {
    chosen = JSON.parse(stored.valueJson);
  } catch {
    throw dataErrors.create("data.incompatible_record");
  }
  if (!isObject(chosen)) {
    throw dataErrors.create("data.incompatible_record");
  }
  return chosen;
};

/** Only the fields of `chosen` the App declares now. */
const declaredOf = (
  operation: ResolvedPreferenceOperation,
  chosen: Record<string, Json>
): Record<string, Json> => {
  const declared = declaredNames(operation.preferences);
  return Object.fromEntries(
    Object.entries(chosen).filter(([name]) => declared.has(name))
  );
};

/** What both operations answer: the fields and `_rev`, as declared. */
const answerOf = (
  operation: ResolvedPreferenceOperation,
  fields: Record<string, Json>,
  revision: number
): Json =>
  checked(operation.returns, { ...fields, _rev: revision }, () =>
    operationErrors.create("contract.invalid_return")
  );

/** The answer a keyed write kept, read back. */
const keptAnswer = (answerJson: string): Json =>
  // SAFETY: core wrote it, as the canonical text of an answer it checked.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  JSON.parse(answerJson) as Json;

/** `get`: what the person has, watched by their own revision. */
const answerGet = (
  operation: ResolvedPreferenceOperation,
  caller: PreferencesCaller,
  storeId: StoreId,
  stored: StoredPreferences
): OperationResult => {
  // Told first, whatever the document holds: a read refused because a
  // stored value no longer fits still follows the person's next write, so
  // a screen showing the refusal gets the repaired document.
  caller.observeReads?.(storeId, {
    [preferencesWatch(caller.userId)]: stored.revision,
  });
  const fields = effectiveOf(operation, chosenOf(stored), () =>
    dataErrors.create("data.incompatible_record")
  );
  return { ok: true, value: answerOf(operation, fields, stored.revision) };
};

/** What the person has now, or undefined when it no longer fits. */
const currentOf = (
  operation: ResolvedPreferenceOperation,
  chosen: Record<string, Json>
): Record<string, Json> | undefined => {
  try {
    return effectiveOf(operation, chosen, () =>
      dataErrors.create("data.incompatible_record")
    );
  } catch {
    return undefined;
  }
};

/**
 * Answers `operation` for `caller` with `input`, as a function's call is
 * answered; throws why it can't, as the operation host does.
 */
export const answerPreferences = async (
  env: Env,
  caller: PreferencesCaller,
  operation: ResolvedPreferenceOperation,
  input: unknown,
  idempotencyKey?: string
): Promise<OperationResult> => {
  const args = checked(operation.args, input, () =>
    operationErrors.create("contract.invalid_args")
  );
  await caller.gate();
  const { storeId, stub } = storeOfRelease(env, caller.release);
  const stored = await stub.readPreferences(storeId, caller.userId);
  if (operation.name === "get") {
    return answerGet(operation, caller, storeId, stored);
  }
  const { expectedRevision, patch } = args;
  if (!isObject(patch)) {
    throw operationErrors.create("contract.invalid_args");
  }
  const key =
    idempotencyKey === undefined
      ? undefined
      : submissionErrors.parse(
          "submission.key_invalid",
          idempotencyKeySchema,
          idempotencyKey
        );
  // What the key was used for: these arguments, under this release and
  // contract. A resend under another release (whose answer would have
  // another shape) is another change.
  const inputHash = await sha256Hex(
    canonicalText({
      args,
      manifestHash: caller.release.manifestHash,
      fingerprint: operation.fingerprint,
    })
  );
  // A resend of the last write, its answer lost: that answer again, not a
  // conflict with itself. The same key for another change is refused.
  if (key !== undefined && stored.lastKey === key) {
    if (stored.lastInputHash !== inputHash || stored.lastAnswerJson === null) {
      throw submissionErrors.create("submission.key_conflict");
    }
    return { ok: true, value: keptAnswer(stored.lastAnswerJson) };
  }
  if (expectedRevision !== stored.revision) {
    throw dataErrors.create("data.conflict");
  }
  // Only the fields the patch names: one it leaves out stays as it was.
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  );
  const before = chosenOf(stored);
  // What the person chose, with the patch, stored as that and never with
  // the defaults: a later default reaches them. Keys the App no longer
  // declares are dropped as they are written, so the document never
  // grows with what earlier versions declared. Checked whole as the
  // App's preferences now, the stored values with the patch's over them:
  // a patch that replaces a value that no longer fits is taken.
  const chosen = { ...declaredOf(operation, before), ...changed };
  const next = effectiveOf(operation, chosen, () =>
    dataErrors.create("data.incompatible_record")
  );
  // A patch that changes nothing they have writes nothing: the revision
  // stays.
  const current = currentOf(operation, before);
  if (current !== undefined && canonicalText(next) === canonicalText(current)) {
    return { ok: true, value: answerOf(operation, current, stored.revision) };
  }
  const answer = answerOf(operation, next, stored.revision + 1);
  // As late as it can be: access lost since the read writes nothing.
  await caller.gate();
  const written = await stub.writePreferences(
    storeId,
    caller.userId,
    stored.revision,
    canonicalText(chosen),
    key === undefined
      ? undefined
      : { key, inputHash, answerJson: canonicalText(answer) }
  );
  if ("replay" in written) {
    return { ok: true, value: keptAnswer(written.replay) };
  }
  if ("keyConflict" in written) {
    throw submissionErrors.create("submission.key_conflict");
  }
  // Another write landed since this one read: the caller reads again.
  if ("conflict" in written) {
    throw dataErrors.create("data.conflict");
  }
  return { ok: true, value: answer };
};
