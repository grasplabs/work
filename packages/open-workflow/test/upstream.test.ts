import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

import { openWorkflowProvenance } from "../src/provenance.ts";
import { validateWorkflow } from "../src/validate.ts";
import license from "../vendor/open-workflow-1.0.3/LICENSE?raw";
import upstreamYaml from "../vendor/open-workflow-1.0.3/workflow.yaml?raw";
import { fixtures, noteSummary, options } from "./fixtures.ts";

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
