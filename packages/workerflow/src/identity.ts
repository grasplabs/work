// The identities a run and its steps are known by.
import { namedError } from "./errors.ts";

/** Cloudflare Workflows' rule for an instance ID. */
const instanceIdPattern = /^[\w][\w-]{0,99}$/u;

/**
 * The reference's rule for an ID a run is addressed by (`deleteBatch`):
 * wider than the one `create` takes, and up to 271 characters.
 */
const addressableIdPattern = /^[\w, */#-]{1,271}$/u;

/** Control characters, which no cron expression holds. */
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const controlCharacter = /[\u0000-\u001F\u007F]/u;

/** The most entries `createBatch` and `deleteBatch` take in one call. */
export const maxBatchSize = 100;

/** The longest cron expression a schedule's identity is drawn from. */
export const maxCronLength = 256;

/** The native step-name limit (Grasp's authored names are narrower). */
export const maxStepNameLength = 256;

/** The longest start key `admit` takes. */
export const maxStartKeyLength = 256;

/** The longest delivery key `deliverEvent` takes. */
export const maxEventKeyLength = 256;

/**
 * An event type follows the instance ID's rule. Cloudflare's own rule for
 * event types isn't pinned yet; this is the narrower guess until it is.
 */
export const assertEventType = (type: unknown): string => {
  if (typeof type !== "string" || !instanceIdPattern.test(type)) {
    throw new TypeError(
      `An event type is 1 to 100 letters, digits, - and _, not starting with -: ${JSON.stringify(type)}`
    );
  }
  return type;
};

/** Whether `id` is one `create` takes: the reference's rule. */
export const isInstanceId = (id: unknown): id is string =>
  typeof id === "string" && instanceIdPattern.test(id);

/** Whether `id` is one a run can be addressed by in `deleteBatch`. */
export const isAddressableId = (id: unknown): id is string =>
  typeof id === "string" && addressableIdPattern.test(id);

/**
 * What the reference throws for an ID `create` doesn't take: an error
 * named WorkflowError, with the reference's message, then the ID.
 */
export const invalidInstanceId = (id: unknown): Error =>
  namedError(
    "WorkflowError",
    `Workflow instance has invalid id: ${typeof id === "string" ? JSON.stringify(id) : `a ${typeof id}`} (1 to 100 letters, digits, - and _, not starting with -)`
  );

/**
 * What every schedule occurrence's ID starts with (`scheduleInstanceId`),
 * and no other's: a caller's ID that starts with it is refused, so no
 * `create` or `admit` takes an occurrence's run before its schedule does.
 */
export const schedulePrefix = "schedule-";

/** An ID a caller gives: the reference's rule, the schedule prefix not. */
export const assertInstanceId = (id: unknown): string => {
  if (!isInstanceId(id)) {
    throw invalidInstanceId(id);
  }
  if (id.startsWith(schedulePrefix)) {
    throw namedError(
      "WorkflowError",
      `Workflow instance has invalid id: ${JSON.stringify(id)} (IDs starting with ${JSON.stringify(schedulePrefix)} are the schedule's own)`
    );
  }
  return id;
};

/** When a schedule fired, and the cron expression that fired it. */
export interface Schedule {
  readonly cron: string;
  /** Milliseconds since the Unix epoch, as the reference gives it. */
  readonly scheduledTime: number;
}

/**
 * A schedule's occurrence, checked: a cron expression of 1 to 256
 * characters, none of them control characters, and a time that is a
 * whole number of milliseconds from 0.
 */
export const readSchedule = (
  cron: unknown,
  scheduledTime: unknown
): Schedule => {
  if (
    typeof cron !== "string" ||
    cron.length === 0 ||
    cron.length > maxCronLength ||
    controlCharacter.test(cron)
  ) {
    throw new TypeError(
      `A schedule's cron is 1 to ${maxCronLength} characters, none of them control characters: ${typeof cron === "string" ? JSON.stringify(cron) : `a ${typeof cron}`}`
    );
  }
  if (
    typeof scheduledTime !== "number" ||
    !Number.isSafeInteger(scheduledTime) ||
    scheduledTime < 0
  ) {
    throw new TypeError(
      `A schedule's scheduledTime is a whole number of milliseconds from 0: ${String(scheduledTime)}`
    );
  }
  return { cron, scheduledTime };
};

/** A schedule as the journal keeps it (JSON), read back and checked. */
export const scheduleOf = (text: string): Schedule => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError(`The journal holds a schedule that isn't one: ${text}`);
  }
  return readSchedule(
    Reflect.get(parsed, "cron"),
    Reflect.get(parsed, "scheduledTime")
  );
};

/** The bytes of the cron's hash a schedule's ID keeps. */
const scheduleHashBytes = 16;

/**
 * The instance ID of one occurrence of a schedule: the same cron and time
 * always give the same ID, so a tick delivered twice finds the run the
 * first one made. The cron is hashed (128 bits of its SHA-256), so the ID
 * stays within what `create` takes however long the expression is: at
 * most 9 + 32 + 1 + 16 characters, letters, digits and - only.
 */
export const scheduleInstanceId = async (
  schedule: Schedule
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(schedule.cron)
  );
  const hex = [...new Uint8Array(digest).slice(0, scheduleHashBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${schedulePrefix}${hex}-${schedule.scheduledTime}`;
};

export const assertStepName = (name: unknown): string => {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > maxStepNameLength
  ) {
    throw new TypeError(
      `A step's name is a string of 1 to ${maxStepNameLength} characters: ${JSON.stringify(name)}`
    );
  }
  return name;
};

/**
 * The name of a run's Durable Object: the definition and the instance ID,
 * encoded so that no two pairs give the same name (JSON quotes and escapes
 * both). The object ID the host derives from it is the host's own mapping.
 */
export const runObjectName = (definition: string, instanceId: string): string =>
  JSON.stringify(["workerflow-run", definition, instanceId]);

/**
 * A step occurrence's idempotency key: the random ID of the run's
 * execution the step first ran in, then the step's identity. The name is
 * last, so the key reads unambiguously whatever the name holds. A retry
 * keeps the key; a restart draws another execution ID, so a step it runs
 * again gets another key, and the receiver can tell a deliberate rerun
 * from a redelivery. A run created again under the same instance ID is
 * another execution too.
 */
export const stepKey = (
  executionUid: string,
  step: { type: string; name: string; occurrence: number }
): string => `${executionUid}:${step.type}:${step.occurrence}:${step.name}`;

/** CloudEvents' rule for an attribute's name. */
const attributeNamePattern = /^[a-z0-9]{1,20}$/u;

/** The most attributes an event is sent with, or a match names. */
export const maxEventAttributes = 16;

/** The longest value an event attribute has. */
export const maxEventAttributeLength = 1024;

/** The most entries one `waitForMatch` takes. */
export const maxEventMatches = 16;

/** Attributes as the journal keeps them: their names in order. */
const canonicalAttributes = (
  attributes: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes).toSorted(([a], [b]) => (a < b ? -1 : 1))
  );

/**
 * An event's attributes, checked: a plain object of 0 to 16 names by
 * CloudEvents' rule, each a string of at most 1,024 characters; as the
 * journal keeps them, names in order (`null` for none).
 */
export const eventAttributesOf = (attributes: unknown): string | null => {
  if (attributes === undefined || attributes === null) {
    return null;
  }
  if (
    typeof attributes !== "object" ||
    Array.isArray(attributes) ||
    Object.getPrototypeOf(attributes) !== Object.prototype
  ) {
    throw new TypeError("An event's attributes are a plain object");
  }
  const entries = Object.entries(attributes);
  if (entries.length > maxEventAttributes) {
    throw new TypeError(
      `An event has at most ${maxEventAttributes} attributes`
    );
  }
  for (const [name, value] of entries) {
    if (!attributeNamePattern.test(name)) {
      throw new TypeError(
        `An event attribute's name is 1 to 20 lowercase letters and digits: ${JSON.stringify(name).slice(0, 40)}`
      );
    }
    if (typeof value !== "string" || value.length > maxEventAttributeLength) {
      throw new TypeError(
        `An event attribute's value is text of at most ${maxEventAttributeLength} characters: ${name}`
      );
    }
  }
  return entries.length === 0
    ? null
    : JSON.stringify(
        canonicalAttributes(
          // SAFETY: every entry was checked to be a string just above.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          attributes as Record<string, string>
        )
      );
};

/** Attributes as `eventAttributesOf` keeps them, read back. */
const readAttributes = (text: string | null): Record<string, string> => {
  if (text === null) {
    return {};
  }
  // SAFETY: only ever text eventAttributesOf wrote, of names to strings.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(text) as Record<string, string>;
};

/** One entry of a match, as the journal keeps it. */
export interface JournaledMatch {
  type: string;
  attributes: Record<string, string>;
}

/**
 * The entries of a `waitForMatch`, checked: 1 to 16, each an event type
 * and the attributes it must have been sent with; as the journal keeps
 * them, so a replay giving the same match gives the same text.
 */
export const eventMatchOf = (match: unknown): string => {
  if (
    !Array.isArray(match) ||
    match.length === 0 ||
    match.length > maxEventMatches
  ) {
    throw new TypeError(
      `waitForMatch takes 1 to ${maxEventMatches} events to match`
    );
  }
  const entries: JournaledMatch[] = [];
  for (const entry of match) {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("waitForMatch takes { type, attributes? } entries");
    }
    const type = assertEventType(Reflect.get(entry, "type"));
    const attributes = eventAttributesOf(Reflect.get(entry, "attributes"));
    entries.push({ type, attributes: readAttributes(attributes) });
  }
  return JSON.stringify(entries);
};

/** A match as `eventMatchOf` journaled it. */
export const readEventMatch = (text: string): JournaledMatch[] =>
  // SAFETY: only ever text eventMatchOf wrote.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(text) as JournaledMatch[];

/**
 * Whether an event of `type`, sent with the attributes `attributes` (as
 * `eventAttributesOf` keeps them), matches any entry of `match`.
 */
export const eventMatches = (
  match: readonly JournaledMatch[],
  type: string,
  attributes: string | null
): boolean => {
  const sent = readAttributes(attributes);
  return match.some(
    (entry) =>
      entry.type === type &&
      Object.entries(entry.attributes).every(
        ([name, value]) => Object.hasOwn(sent, name) && sent[name] === value
      )
  );
};
