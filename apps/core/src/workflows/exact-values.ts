import type { ValueSchema } from "@grasp-os/sdk";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { canonicalJson } from "@grasp-os/shared/json";
import { z } from "zod";

import { envelopedSchema, readEnvelope } from "./connector-schemas.ts";

// What a JSON workflow run's schemas and contracts check: a value as it
// is. A task's schema (resource-host.ts) and a call's contract
// (resource-calls.ts) check what crosses them; they never fill in, coerce
// or change it. One rule, and one cache of the native schemas it uses.

/** Native schemas by their descriptor's JSON text, made once each. */
const schemas = new Map<string, ReturnType<typeof schemaFromDescriptor>>();
const schemasMax = 256;

/** The native schema of `descriptor` (its JSON text), made once. */
export const schemaOfDescriptor = (
  descriptor: string
): ReturnType<typeof schemaFromDescriptor> => {
  let schema = schemas.get(descriptor);
  if (schema === undefined) {
    schema = schemaFromDescriptor(descriptor);
    schemas.set(descriptor, schema);
    if (schemas.size > schemasMax) {
      const [oldest] = schemas.keys();
      if (oldest !== undefined) {
        schemas.delete(oldest);
      }
    }
  }
  return schema;
};

/**
 * Whether the schema of `descriptor` (its JSON text, or a connector
 * operation's JSON Schema envelope) takes `value`
 * exactly as it is: plain JSON its validator accepts, answering the same
 * value back, canonically. The validator gets a copy, and its answer is
 * compared with the text taken before it ran.
 */
export const takesExactly = (descriptor: string, value: unknown): boolean => {
  const parsed = z.json().safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const snapshot = canonicalJson(parsed.data);
  // A connector's own JSON Schema (connector-schemas.ts): its descriptor
  // takes the value exactly, and the schema's full check, its patterns and
  // formats, takes it too.
  let schema: ValueSchema<unknown, unknown>;
  if (envelopedSchema(descriptor) === undefined) {
    schema = schemaOfDescriptor(descriptor);
  } else {
    const read = readEnvelope(descriptor);
    if (read === undefined || !read.accepts(parsed.data)) {
      return false;
    }
    ({ schema } = read);
  }
  const validated = schema["~standard"].validate(JSON.parse(snapshot));
  if ("then" in validated || validated.issues !== undefined) {
    return false;
  }
  const answer = z.json().safeParse(validated.value);
  return answer.success && canonicalJson(answer.data) === snapshot;
};
