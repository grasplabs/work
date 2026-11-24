import { toHex } from "./encoding.ts";

// Record IDs (spec 32.1): UUIDv7 in lower case, the format `v.id` accepts.
// Core mints one when a mutation stages an insert, so the mutation can
// read and return the record before it commits; App code never chooses
// one. The time in it is only for an index's locality: a record's
// creation time is the host's metadata, never read from its ID.

/** A UUIDv7 in lower case. */
export const recordIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * A new record ID: 48 bits of the time in milliseconds, the version, 74
 * random bits and the variant (RFC 9562).
 */
export const mintRecordId = (now = Date.now()): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 + ((bytes[6] ?? 0) % 16);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 64);
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
