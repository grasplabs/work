import { canonicalText } from "@grasp-os/shared/json";

import type { ValueDescriptor } from "./value-descriptor.ts";

// How a store's preferences contract changes when a version is sealed on
// it (spec 10.7.7, GRA-771): which changes to an App's preferences are
// accepted, and what the contract is afterwards. Pure: the store's host
// runs it inside the transaction that applies it
// (apps/core/src/store-host.ts, `definePreferences`).
//
// A store's preferences contract is every preference any version sealed
// on it declared, by name, with its descriptor: the union, as its schema
// contract is for tables (schema-plan.ts). People's stored preferences
// hold only what they chose, never a default (app-preferences.ts), so a
// change is safe when every value the contract allows still fits:
//
// - a new preference: nobody chose it yet; it has a default (registration
//   requires one), which everyone answers;
// - a preference the version leaves out: kept in the contract, and in
//   people's documents until they next write;
// - a changed default: defaults are never stored, so the new one reaches
//   only those who never chose, and nothing is rewritten.
//
// Anything else changing a preference's descriptor is refused: its kind,
// constraints, enum values, nullability, nested fields. Widening too: a
// version that widens one lets people store what an older version, run
// again after a rollback, refuses; table fields refuse widening alike. So
// is adding back a removed preference in another shape: people's
// documents may still hold the old one. There are no preference
// migrations: a new shape is a new preference, under a new name.

/** A store's preferences contract: each preference ever declared, by name. */
export type PreferencesContract = Readonly<Record<string, ValueDescriptor>>;

/** Why a preference change is refused. */
export type PreferenceRefusalReason = "preference_changed";

/** One preference refused, and why. */
export interface PreferenceRefusal {
  readonly preference: string;
  readonly reason: PreferenceRefusalReason;
}

/** An accepted change: the contract after it. */
export interface AcceptedPreferencePlan {
  readonly accepted: true;
  readonly contract: PreferencesContract;
  /** Whether the contract differs from the one before. */
  readonly changed: boolean;
}

/** A refused change: every preference it changes. */
export interface RefusedPreferencePlan {
  readonly accepted: false;
  readonly refused: readonly PreferenceRefusal[];
}

export type PreferencePlan = AcceptedPreferencePlan | RefusedPreferencePlan;

/** `descriptor` without its default: what a stored value has to fit. */
const shapeOf = (descriptor: ValueDescriptor): string => {
  const { defaultValue: _default, ...shape } = descriptor;
  return canonicalText(shape);
};

/**
 * The plan of a version's `preferences` (a strict object's descriptor, or
 * null for none) onto a store's `contract` (null for a store that has
 * none yet).
 */
export const planPreferenceChange = (
  contract: PreferencesContract | null,
  preferences: ValueDescriptor | null
): PreferencePlan => {
  const before = contract ?? {};
  const declared =
    preferences !== null && preferences.kind === "object"
      ? preferences.fields
      : {};
  const refused: PreferenceRefusal[] = [];
  const after: Record<string, ValueDescriptor> = { ...before };
  for (const name of Object.keys(declared).toSorted()) {
    const descriptor = declared[name];
    if (descriptor === undefined) {
      continue;
    }
    const known = Object.hasOwn(before, name) ? before[name] : undefined;
    if (known !== undefined && shapeOf(known) !== shapeOf(descriptor)) {
      refused.push({ preference: name, reason: "preference_changed" });
      continue;
    }
    // New, or the same shape: the contract holds this version's, its
    // default included, which only says what a reader answers.
    after[name] = descriptor;
  }
  if (refused.length > 0) {
    return { accepted: false, refused };
  }
  const sorted = Object.fromEntries(
    Object.entries(after).toSorted(([a], [b]) => (a < b ? -1 : 1))
  );
  return {
    accepted: true,
    contract: sorted,
    changed: canonicalText(sorted) !== canonicalText(before),
  };
};
