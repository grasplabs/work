import { describe, expect, it } from "vite-plus/test";

import type { SealedTask } from "../src/workflow-builds.ts";
import { failureOf } from "../src/workflows/resource-errors.ts";

// What a catch may take of a step's failure, and as what (spec 13.7): the
// mapping of the host's failures to upstream errors, pure logic, so tested
// on its own. Integration through a run is workflow-failures.test.ts's.

const task: SealedTask = {
  id: "send",
  pointer: "/do/0/guard/try/0/send",
  kind: "set",
  steps: ["task"],
  scope: [],
  schemas: {},
};

/** A call task of `name`, a call whose effect runs once. */
const onceTask = (
  name: "grasp.action" | "grasp.operation" | "grasp.model"
): SealedTask => {
  const base = {
    id: "charge",
    pointer: "/do/0/guard/try/0/charge",
    kind: "call" as const,
    steps: ["task" as const],
    scope: [],
    schemas: {},
  };
  if (name === "grasp.model") {
    return {
      ...base,
      call: {
        name,
        binding: "m",
        instructions: { literal: "" },
        input: { literal: "" },
        outputSchema: {},
      },
    };
  }
  if (name === "grasp.action") {
    return {
      ...base,
      call: {
        name,
        binding: "a",
        module: "code/a.ts",
        export: "a",
        arguments: { literal: null },
      },
    };
  }
  return {
    ...base,
    call: { name, binding: "o", arguments: { literal: null } },
  };
};

const standard = "https://open-workflow-specification.org/spec/1.0.0/errors/";

describe("a step's failure, as a catch sees it", () => {
  it("never lets a catch take an unknown outcome or a refusal of the module", () => {
    const codes = [
      "connect.outcome_unknown",
      "connect.outcome_unknown_unresolved",
      "effect.outcome_unknown",
      "operation.outcome_unknown",
      "operation.sandbox_lost",
      "workflow.invalid",
      "execution.stale_attempt",
    ];
    expect(
      codes.map((code) =>
        failureOf({ name: "Error", message: "", code }, task, false)
      )
    ).toStrictEqual(codes.map(() => ({ catchable: false })));
    expect({
      tampered: failureOf(
        { name: "Error", message: "", code: "permission.denied" },
        task,
        true
      ),
      noTask: failureOf(
        { name: "TimeoutError", message: "" },
        undefined,
        false
      ),
    }).toStrictEqual({
      tampered: { catchable: false },
      noTask: { catchable: false },
    });
  });

  it("never lets a catch take a timeout of a call that runs its effect once, or of a connector call", () => {
    const timeouts = [
      { name: "TimeoutError", message: "" },
      { name: "Error", message: "", code: "operation.deadline_exceeded" },
    ];
    expect(
      (["grasp.action", "grasp.operation", "grasp.model"] as const).flatMap(
        (name) =>
          timeouts.map(
            (error) => failureOf(error, onceTask(name), false).catchable
          )
      )
    ).toStrictEqual([false, false, false, false, false, false]);
    // A connector call that ran out of time on every attempt: its send may
    // have gone out, and no attempt had connect's definite answer.
    const connector: SealedTask = {
      id: "send",
      pointer: "/do/0/guard/try/0/send",
      kind: "call",
      steps: ["task"],
      scope: [],
      schemas: {},
      call: {
        name: "grasp.connector",
        binding: "mail",
        operation: "mail.send",
        arguments: { literal: null },
      },
    };
    expect(
      failureOf({ name: "TimeoutError", message: "" }, connector, false)
    ).toStrictEqual({ catchable: false });
  });

  it("maps the host's failures to standard types, never with the step's own message", () => {
    const typeOf = (error: { name: string; code?: string }) => {
      const failure = failureOf(
        { ...error, message: "with data the run read" },
        task,
        false
      );
      return failure.catchable
        ? {
            type: failure.error.type.slice(standard.length),
            status: failure.error.status,
            detail: failure.error.detail,
            leaks: failure.error.title?.includes("data") ?? false,
          }
        : undefined;
    };
    expect({
      timeout: typeOf({ name: "TimeoutError" }),
      denied: typeOf({ name: "Error", code: "permission.denied" }),
      inactive: typeOf({ name: "Error", code: "permission.person_inactive" }),
      data: typeOf({ name: "Error", code: "workflow.task_data_invalid" }),
      expression: typeOf({ name: "Error", code: "expression.failed" }),
      connector: typeOf({ name: "Error", code: "connect.declined" }),
      store: typeOf({ name: "Error", code: "resource.operation_failed" }),
      unknown: typeOf({ name: "Error" }),
    }).toStrictEqual({
      timeout: {
        type: "timeout",
        status: 408,
        detail: undefined,
        leaks: false,
      },
      denied: {
        type: "authorization",
        status: 403,
        detail: undefined,
        leaks: false,
      },
      inactive: {
        type: "authorization",
        status: 403,
        detail: undefined,
        leaks: false,
      },
      data: {
        type: "validation",
        status: 400,
        detail: undefined,
        leaks: false,
      },
      expression: {
        type: "expression",
        status: 400,
        detail: undefined,
        leaks: false,
      },
      connector: {
        type: "communication",
        status: 500,
        detail: undefined,
        leaks: false,
      },
      store: { type: "runtime", status: 500, detail: undefined, leaks: false },
      unknown: {
        type: "runtime",
        status: 500,
        detail: undefined,
        leaks: false,
      },
    });
  });

  it("takes the workflow's own error only from a raise, as the raise declared it", () => {
    const raise: SealedTask = {
      id: "deny",
      pointer: "/do/0/guard/try/0/deny",
      kind: "raise",
      steps: ["task"],
      scope: [],
      schemas: {},
      error: { type: "urn:grasp:error:denied", status: 409, title: "Denied." },
    };
    const raised = {
      name: "NonRetryableError",
      message: "",
      code: "workflow.raised",
    };
    expect({
      raise: failureOf(raised, raise, false),
      other: failureOf(raised, task, false),
    }).toStrictEqual({
      raise: {
        catchable: true,
        error: {
          type: "urn:grasp:error:denied",
          status: 409,
          instance: "/do/0/guard/try/0/deny",
          title: "Denied.",
        },
      },
      other: { catchable: false },
    });
  });
});
