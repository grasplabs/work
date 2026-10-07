// The identities a run and its steps are known by.

/** Cloudflare Workflows' rule for an instance ID. */
const instanceIdPattern = /^[\w][\w-]{0,99}$/u;

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

export const assertInstanceId = (id: unknown): string => {
  if (typeof id !== "string" || !instanceIdPattern.test(id)) {
    throw new TypeError(
      `A workflow instance ID is 1 to 100 letters, digits, - and _, not starting with -: ${JSON.stringify(id)}`
    );
  }
  return id;
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
 * A step occurrence's idempotency key: the run's own random ID, drawn when
 * it was created, then the step's identity. The name is last, so the key
 * reads unambiguously whatever the name holds. A run created again under
 * the same instance ID gets another run ID, and its effects other keys.
 */
export const stepKey = (
  runUid: string,
  step: { type: string; name: string; occurrence: number }
): string => `${runUid}:${step.type}:${step.occurrence}:${step.name}`;
