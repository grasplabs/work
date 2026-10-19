import {
  contractFingerprint,
  preferenceOperations,
  preferencePaths,
  schemaFromDescriptor,
} from "@grasp-os/sdk/host";
import type { PreferenceOperationName } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import { dataErrors } from "@grasp-os/shared/stores";

import type { Release } from "./app-releases.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { preferencesTable } from "./store-host.ts";

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
// - Access lost mid-call: the caller's gate (the release not revoked, the
//   person's role read again, the deadline) runs before the store is
//   read or written. A live `get` is read again through the screen's
//   subscription, which lets go once access goes.
// - What a live read tells: a watch is told only that the preferences'
//   generation moved, never whose; core reads again as the subscriber.
// - Stored preferences that no longer fit the App's (a later version
//   changed them): only what the person chose is stored, never a default,
//   so a field they never set is answered with the default in force. A
//   stored key the App no longer declares is left out of the answer and
//   kept as stored, so going back to a version with it finds it again. A
//   declared field whose stored value no longer fits is refused
//   (`data.incompatible_record`), never coerced, dropped or rewritten.

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
  if (
    reference.resourceId !== release.manifest.resourceId ||
    reference.resourceVersion !== release.manifest.resourceVersion ||
    reference.fingerprint !== (await contractFingerprint(operation))
  ) {
    throw versionErrors.create("version.mismatch");
  }
  return {
    name,
    preferences: declared,
    args: operation.args,
    returns: operation.returns,
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

/**
 * The person's document: what they chose, as stored (only the fields
 * they set, never a default, so a later default reaches them); what that
 * is under the App's preferences now, defaults filling in the rest; and
 * its revision.
 */
const documentOf = (
  operation: ResolvedPreferenceOperation,
  stored: { valueJson: string | null; revision: number }
): {
  chosen: Record<string, Json>;
  fields: Record<string, Json>;
  revision: number;
} => {
  let chosen: unknown = {};
  if (stored.valueJson !== null) {
    try {
      chosen = JSON.parse(stored.valueJson);
    } catch {
      throw dataErrors.create("data.incompatible_record");
    }
  }
  if (!isObject(chosen)) {
    throw dataErrors.create("data.incompatible_record");
  }
  return {
    chosen,
    fields: effectiveOf(operation, chosen, () =>
      dataErrors.create("data.incompatible_record")
    ),
    revision: stored.revision,
  };
};

/** What both operations answer: the fields and `_rev`, as declared. */
const answerOf = (
  operation: ResolvedPreferenceOperation,
  document: { fields: Record<string, Json>; revision: number }
): Json => {
  const answer = { ...document.fields, _rev: document.revision };
  return checked(operation.returns, answer, () =>
    operationErrors.create("contract.invalid_return")
  );
};

/**
 * Answers `operation` for `caller` with `input`, as a function's call is
 * answered; throws why it can't, as the operation host does.
 */
export const answerPreferences = async (
  env: Env,
  caller: PreferencesCaller,
  operation: ResolvedPreferenceOperation,
  input: unknown
): Promise<OperationResult> => {
  const args = checked(operation.args, input, () =>
    operationErrors.create("contract.invalid_args")
  );
  await caller.gate();
  const { storeId, stub } = storeOfRelease(env, caller.release);
  const stored = await stub.readPreferences(storeId, caller.userId);
  const current = documentOf(operation, stored);
  if (operation.name === "get") {
    caller.observeReads?.(storeId, { [preferencesTable]: stored.generation });
    return { ok: true, value: answerOf(operation, current) };
  }
  const { expectedRevision, patch } = args;
  if (!isObject(patch)) {
    throw operationErrors.create("contract.invalid_args");
  }
  if (expectedRevision !== current.revision) {
    throw dataErrors.create("data.conflict");
  }
  // Only the fields the patch names: one it leaves out stays as it was.
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  );
  // What the person chose, with the patch: stored as that, never with
  // the defaults, and checked whole as the App's preferences now.
  const chosen = { ...current.chosen, ...changed };
  const next = effectiveOf(operation, chosen, () =>
    operationErrors.create("contract.invalid_args")
  );
  // A patch that changes nothing they have writes nothing: the revision
  // stays.
  if (canonicalText(next) === canonicalText(current.fields)) {
    return { ok: true, value: answerOf(operation, current) };
  }
  const written = await stub.writePreferences(
    storeId,
    caller.userId,
    current.revision,
    canonicalText(chosen)
  );
  // Another write landed since this one read: the caller reads again.
  if ("conflict" in written) {
    throw dataErrors.create("data.conflict");
  }
  return {
    ok: true,
    value: answerOf(operation, { fields: next, revision: written.revision }),
  };
};
