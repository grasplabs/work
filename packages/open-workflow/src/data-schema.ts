import { compileDataSchema } from "@grasp-os/workflow-schema/data-schema";
import type {
  SchemaCompilation,
  SchemaProblem,
} from "@grasp-os/workflow-schema/data-schema";

import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonValue } from "./json-text.ts";

// Data schemas compile in @grasp-os/workflow-schema (data-schema.ts); the
// profile wraps them in an envelope of its own, read here until the profile
// goes (GRA-1535).

const refused = (problem: SchemaProblem): SchemaCompilation => ({
  ok: false,
  problems: [problem],
});

/**
 * The `{ format: "json", document }` envelope of upstream input, output and
 * export schemas. Only inline JSON documents: `resource` is never loaded.
 */
export const compileSchemaEnvelope = (
  envelope: JsonValue | undefined,
  pointer: string
): SchemaCompilation => {
  if (!isObject(envelope)) {
    return refused({
      code: "schema.invalid",
      pointer,
      remedy: 'Write the schema as { "format": "json", "document": { … } }.',
    });
  }
  for (const key of Object.keys(envelope)) {
    if (key === "resource") {
      return refused({
        code: "schema.external",
        pointer: pointerJoin(pointer, key),
        remedy:
          "Write the schema inline as document: external schemas aren't loaded.",
      });
    }
    if (key !== "format" && key !== "document") {
      return refused({
        code: "schema.unsupported_keyword",
        pointer: pointerJoin(pointer, key),
        remedy: "A schema envelope has only format and document.",
      });
    }
  }
  if (Object.hasOwn(envelope, "format") && envelope.format !== "json") {
    return refused({
      code: "schema.invalid",
      pointer: pointerJoin(pointer, "format"),
      remedy: 'Set format to "json".',
      expected: "json",
    });
  }
  if (!Object.hasOwn(envelope, "document")) {
    return refused({
      code: "schema.invalid",
      pointer: pointerJoin(pointer, "document"),
      remedy: "Give the schema an inline document.",
    });
  }
  return compileDataSchema(envelope.document, pointerJoin(pointer, "document"));
};
