import type { Json } from "@grasp-os/shared/json";
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
  return result;
};

/** Whether `value` passes `read`: its descriptor and its full check. */
const passes = (schema: ReturnType<typeof read>, value: Json): boolean => {
  const result = schema.schema["~standard"].validate(value);
  return (
    !("then" in result) && result.issues === undefined && schema.accepts(value)
  );
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

  it("enforce the patterns and formats a descriptor can't say", () => {
    const list = read(
      microsoft365.manifest.actions["mail.list"]?.contract.input
    );
    const at = (receivedAfter: string) =>
      passes(list, { mailbox: "team@acme.test", receivedAfter });
    expect({
      valid: at("2026-10-12T09:00:00Z"),
      leapDay: at("2028-02-29T09:00:00+01:00"),
      // A mailbox with a path in it, which the connector's pattern refuses.
      badPattern: passes(list, { mailbox: "team/../other" }),
      notADate: at("yesterday"),
      noSuchDay: at("2026-02-31T09:00:00Z"),
      notALeapYear: at("2027-02-29T09:00:00Z"),
    }).toStrictEqual({
      valid: true,
      leapDay: true,
      badPattern: false,
      notADate: false,
      noSuchDay: false,
      notALeapYear: false,
    });
  });

  it("check formats as exactly as the connectors' own schemas, and count code points", () => {
    const email = read({ type: "string", format: "email" });
    const short = read({ type: "string", maxLength: 2 });
    expect({
      email: passes(email, "ada.lovelace@acme.test"),
      doubleDot: passes(email, "ada..lovelace@acme.test"),
      noTopLevel: passes(email, "ada@acme"),
      twoEmoji: passes(short, "😀😀"),
      threeEmoji: passes(short, "😀😀😀"),
    }).toStrictEqual({
      email: true,
      doubleDot: false,
      noTopLevel: false,
      twoEmoji: true,
      threeEmoji: false,
    });
  });

  it("refuse any keyword it doesn't enforce, rather than drop it", () => {
    const string = { type: "string" };
    const unreadable = [
      { type: "number", exclusiveMinimum: 0 },
      { type: "number", multipleOf: 2 },
      { type: "array", items: string, uniqueItems: true },
      { type: "array", items: string, contains: string },
      { type: "object", additionalProperties: string, maxProperties: 3 },
      { type: "string", format: "uri" },
      {
        type: "object",
        properties: { a: string },
        required: ["a", "b"],
        additionalProperties: false,
      },
      { type: "string", pattern: "(" },
    ].map((schema) => readContractSchema(JSON.stringify(schema)));
    expect(unreadable.every((each) => each === undefined)).toBeTruthy();
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
