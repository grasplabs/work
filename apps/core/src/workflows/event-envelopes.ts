import { sha256Hex } from "@grasp-os/shared/encoding";
import { z } from "zod";

// The events of a run's inbox as the host keeps them and a listen task
// reads them (run-events.ts admits them; resource-host.ts takes them):
// their envelopes, all but the time minted by the host as each is
// admitted, and the engine's type each is kept under.

/** CloudEvents' version, which every envelope names. */
export const specVersion = "1.0";

/** The content type of every event's data: JSON, as the contract has it. */
export const contentType = "application/json";

/**
 * The engine's type for events of CloudEvents type `type` admitted
 * through binding `alias`: both together, so no listen on another binding
 * matches them. Within the engine's rule for types (letters, digits, `-`
 * and `_`, at most 100), whatever characters a CloudEvents type has.
 */
export const eventTypeKey = async (
  alias: string,
  type: string
): Promise<string> => `ce-${await sha256Hex(`${alias}\n${type}`)}`;

/** An event as the engine keeps it for its run: all but its time. */
export const storedEventSchema = z.strictObject({
  id: z.string().min(1).max(128),
  source: z.string().min(1).max(1024),
  type: z.string().min(1).max(256),
  subject: z.string().max(1024).optional(),
  datacontenttype: z.literal(contentType),
  data: z.json(),
});
export type StoredEvent = z.infer<typeof storedEventSchema>;

/**
 * The attributes a listen's filter may match an event by, as the engine
 * keeps them beside it: every attribute of its envelope but its type
 * (which `eventTypeKey` keeps), its data and its time.
 */
export const attributesOf = (stored: StoredEvent): Record<string, string> => ({
  id: stored.id,
  source: stored.source,
  datacontenttype: stored.datacontenttype,
  ...(stored.subject === undefined ? {} : { subject: stored.subject }),
});

/** A CloudEvents envelope, as a listen reading envelopes answers it. */
export type EventEnvelope = StoredEvent & {
  readonly specversion: typeof specVersion;
  readonly time: string;
};

/** `stored`'s envelope, its time when its run accepted it. */
export const envelopeOf = (
  stored: StoredEvent,
  acceptedAt: Date
): EventEnvelope => ({
  specversion: specVersion,
  ...stored,
  time: acceptedAt.toISOString(),
});
