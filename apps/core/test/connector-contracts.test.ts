import { describe, expect, it } from "vite-plus/test";

import googleWorkspace from "../../../packages/connectors/google-workspace/src/index.ts";
import microsoft365 from "../../../packages/connectors/microsoft-365/src/index.ts";
import { readContractSchema } from "../src/connector-contracts.ts";

// Reading a generated connector contract's JSON Schemas as value
// descriptors (pure logic): every native action must be bindable, the
// read schema checks what the connector's own does (looser only where a
// descriptor can't say it), and anything a descriptor can't say fails
// closed.

const connectors = [microsoft365, googleWorkspace];

/** `schema` read from its JSON text; fails the test if it can't be. */
const read = (schema: unknown) => {
  const result = readContractSchema(JSON.stringify(schema));
  if (result === undefined) {
    throw new Error("Unreadable");
  }
  return result.schema;
};

/** Whether `value` passes `schema`. */
const passes = (schema: ReturnType<typeof read>, value: unknown): boolean => {
  const result = schema["~standard"].validate(value);
  return !("then" in result) && result.issues === undefined;
};

describe("generated connector contracts", () => {
  it("read every native action's input and output", () => {
    const unreadable = connectors.flatMap(({ manifest }) =>
      Object.entries(manifest.actions).flatMap(([tool, action]) =>
        (["input", "output"] as const)
          .filter(
            (side) =>
              readContractSchema(JSON.stringify(action.contract[side])) ===
              undefined
          )
          .map((side) => `${manifest.name} ${tool} ${side}`)
      )
    );
    expect(unreadable).toStrictEqual([]);
  });

  it("check what the connector's input schema checks", () => {
    const send = read(
      microsoft365.manifest.actions["mail.send"]?.contract.input
    );
    const valid = {
      mailbox: "team@acme.test",
      subject: "Launch",
      body: "Hello.",
      to: ["ada@acme.test"],
    };
    expect({
      valid: passes(send, valid),
      unknownKey: passes(send, { ...valid, priority: "high" }),
      missing: passes(send, { mailbox: "team@acme.test" }),
      notEmail: passes(send, { ...valid, to: ["ada"] }),
      tooLong: passes(send, { ...valid, subject: "x".repeat(1025) }),
    }).toStrictEqual({
      valid: true,
      unknownKey: false,
      missing: false,
      notEmail: false,
      tooLong: false,
    });
  });

  it("read a nullable value, a union and a map", () => {
    const schema = read({
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        size: { anyOf: [{ type: "number" }, { type: "string" }] },
        labels: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["name", "size", "labels"],
      additionalProperties: false,
    });
    expect({
      nulls: passes(schema, { name: null, size: 1, labels: {} }),
      union: passes(schema, { name: "a", size: "large", labels: { a: "b" } }),
      wrongMap: passes(schema, { name: "a", size: 1, labels: { a: 1 } }),
    }).toStrictEqual({ nulls: true, union: true, wrongMap: false });
  });

  it("fail closed on what a descriptor can't say", () => {
    const unreadable = [
      { $ref: "#/$defs/thing" },
      { type: "object", properties: { a: { type: "string" } } },
      { oneOf: [{ type: "string" }, { type: "number" }] },
      { type: "array", prefixItems: [{ type: "string" }] },
      {},
    ].map((schema) => readContractSchema(JSON.stringify(schema)));
    expect(unreadable).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
