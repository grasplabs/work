import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";

// What an event wait's match is, apart and with nothing of the run's
// inbox imported: the run host checks and hashes what a wait's enter step
// records (sealed-run.ts), and event-waits.ts matches events by the same.

/** The longest value a match takes, as canonical JSON. */
export const maxMatchKeyLength = 512;

/** A value a match takes: text, a finite number or a boolean, bounded. */
export type MatchKey = string | number | boolean;

/** Whether `value` is one a match takes (`MatchKey`). */
export const isMatchKey = (value: unknown): value is MatchKey =>
  (typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))) &&
  canonicalJson(value).length <= maxMatchKeyLength;

/** The hash a wait matches by: the field and the value it must have. */
export const matchHashOf = async (
  field: string,
  key: MatchKey
): Promise<string> => await sha256Hex(canonicalJson([field, key]));
