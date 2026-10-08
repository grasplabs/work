/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

import { openWorkflowProvenance } from "../src/provenance.ts";
import { validateWorkflow } from "../src/validate.ts";
import license from "../vendor/open-workflow-1.0.3/LICENSE?raw";
import upstreamYaml from "../vendor/open-workflow-1.0.3/workflow.yaml?raw";
import { eventRecovery, fixtures, noteSummary, options } from "./fixtures.ts";

// The profile is a restricted subset of the pinned upstream schema, written
// out by hand. These tests hold it to that: the vendored files are the
// pinned bytes, and every definition the profile accepts is also valid
// Open Workflow 1.0.3 by the upstream schema itself.

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const upstream = (): Validator => {
  const schema: unknown = parse(upstreamYaml);
  if (!isSchema(schema)) {
    throw new Error("The vendored schema isn't a JSON Schema object");
  }
  return new Validator(schema, "2020-12", false);
};

/** The note summary with one task in place of its own. */
const withTask = (task: Record<string, unknown>) => ({
  ...noteSummary,
  do: [{ "only-task": task }],
});

interface EventChange {
  emitSource?: string;
  emitDataschema?: string;
  listenSource?: string;
  errorType?: string;
  wait?: string;
}

/** The event-recovery fixture with URI and expression fields set. */
const eventDefinition = (change: EventChange) => ({
  ...eventRecovery,
  do: [
    {
      listening: {
        listen: {
          to: {
            one: {
              with: {
                type: "grasp.job.completed",
                ...(change.listenSource === undefined
                  ? {}
                  : { source: change.listenSource }),
              },
            },
          },
        },
        timeout: { after: { minutes: 1 } },
        metadata: { grasp: { binding: "jobEvents" } },
      },
    },
    {
      announce: {
        emit: {
          event: {
            with: {
              type: "grasp.job.timeout",
              ...(change.emitSource === undefined
                ? {}
                : { source: change.emitSource }),
              ...(change.emitDataschema === undefined
                ? {}
                : { dataschema: change.emitDataschema }),
            },
          },
        },
        metadata: { grasp: { binding: "jobEvents" } },
      },
    },
    ...(change.wait === undefined ? [] : [{ pause: { wait: change.wait } }]),
    {
      failed: {
        if: "${ false }",
        raise: {
          error: { type: change.errorType ?? "urn:grasp:error:x", status: 409 },
        },
      },
    },
    { done: { set: { status: "done" } } },
  ],
});

describe("the vendored Open Workflow schema", () => {
  it("is byte for byte the pinned upstream schema and licence", async () => {
    await expect(sha256(upstreamYaml)).resolves.toBe(
      openWorkflowProvenance.files["workflow.yaml"]
    );
    await expect(sha256(license)).resolves.toBe(
      openWorkflowProvenance.files.LICENSE
    );
    expect(license).toContain("Apache License");
    expect(upstreamYaml).toContain(
      "$id: https://open-workflow-specification.org/schemas/1.0.3/workflow.yaml"
    );
  });

  it("refuses what upstream refuses, and the profile refuses more", async () => {
    const misspelled = withTask({ call: "grasp.now", wiht: {} });
    expect(upstream().validate(misspelled).valid).toBeFalsy();
    const profileMisspelled = await validateWorkflow(
      JSON.stringify(misspelled),
      options
    );
    expect(profileMisspelled.ok).toBeFalsy();

    const raw = withTask({
      call: "http",
      with: { method: "get", endpoint: "https://example.com/" },
    });
    expect(upstream().validate(raw).valid).toBeTruthy();
    const profileRaw = await validateWorkflow(JSON.stringify(raw), options);
    expect(profileRaw.ok).toBeFalsy();
  });

  // What upstream refuses, the profile must refuse too: the profile is a
  // subset. Each case is one field's value, in a definition that is
  // otherwise valid by both.
  it.each([
    ["an emit source that isn't a URI", { emitSource: "not a uri" }],
    [
      "a dataschema with a space",
      { emitDataschema: "https://example.com/a b" },
    ],
    ["a listen source that isn't a URI", { listenSource: "\\no" }],
    ["an error type that isn't a URI", { errorType: "not a uri" }],
    ["a wait expression over two lines", { wait: '${ "PT1S"\n }' }],
    ["a source expression over two lines", { emitSource: "${ .x\n }" }],
  ] as const)("refuses %s, as upstream does", async (_name, change) => {
    const definition = eventDefinition(change);
    expect(upstream().validate(definition).valid).toBeFalsy();
    const result = await validateWorkflow(JSON.stringify(definition), options);
    expect(result.ok).toBeFalsy();
  });

  it("accepts URIs and one-line expressions in those fields, as upstream does", async () => {
    const definition = eventDefinition({
      emitSource: "https://example.com/jobs?id=1#x",
      emitDataschema: "urn:grasp:schema:job",
      listenSource: "${ $workflow.input.jobId }",
      errorType: "urn:grasp:error:job.failed",
      wait: '${ "PT" + "1S" }',
    });
    expect(upstream().validate(definition).valid).toBeTruthy();
    const result = await validateWorkflow(JSON.stringify(definition), options);
    expect(result.ok ? [] : result.diagnostics).toStrictEqual([]);
  });

  it.each(Object.entries(fixtures))(
    "accepts %s, as the profile does",
    async (_name, definition) => {
      const result = await validateWorkflow(
        JSON.stringify(definition),
        options
      );
      expect(result.ok).toBeTruthy();
      const checked = upstream().validate(definition);
      expect(checked.errors.slice(0, 3)).toStrictEqual([]);
      expect(checked.valid).toBeTruthy();
    }
  );
});
