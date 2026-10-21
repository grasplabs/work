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

/**
 * The engine's type of the event a child run's end wakes its parent with
 * (run-children.ts): its run ID, within the engine's rule for types.
 */
export const childEndType = (childRunId: string): string =>
  `child-${childRunId}`;

/**
 * What a child run's end tells its parent, as the event's payload: what it
 * completed with, or how it didn't and its error's code. The parent's wait
 * journals it with the event, so a replay reads the same outcome, however
 * long after the child's own details are gone.
 */
export const childEndSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), output: z.json() }),
  z.strictObject({
    status: z.enum(["failed", "cancelled"]),
    code: z.string().max(256).nullable(),
  }),
]);
export type ChildEnd = z.infer<typeof childEndSchema>;
