import type { Json } from "./json.ts";

// The Brain's audit events, as it records them: who (the host's actor, as
// its `actorOf` port names the caller), what, of what, and identifiers and
// counts only, never what was read or written. The host turns each into
// its own audit log's event (its `audit.eventOf` port).

/** A value an event's detail holds: an identifier or a count. */
export type DetailValue = string | number | boolean | null;

/** An audit event the Brain records, before the host makes it its own. */
export interface BrainEvent {
  /** The host's actor, opaque to the Brain. */
  actor: Json;
  action: string;
  target?: { type: string; id: string };
  detail?: Record<string, DetailValue>;
  provenance?: string[];
}
