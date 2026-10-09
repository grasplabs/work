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
