import type { SealedTask } from "@grasp-os/workflow-schema/sealed";
import { describe, expect, it } from "vite-plus/test";

import { failureOf, retryable } from "../src/workflows/resource-errors.ts";

// What a catch may take of a step's failure, and as what (spec 13.7): the
// mapping of the host's failures to `{ code, message, step }`, pure logic, so tested
// on its own. Integration through a run is workflow-failures.test.ts's.

const task: SealedTask = {
  id: "send",
  pointer: "/steps/0/try/0",
  kind: "switch",
  steps: [],
  scope: [],
};

/** Whether a retry policy may try again `error` of a step of `of`. */
const retries = (error: { name: string; code?: string }, of: SealedTask) =>
  retryable(failureOf({ ...error, message: "" }, of, false), of);

/** A model call's task, a call whose effect runs once. */
const modelTask: SealedTask = {
  id: "charge",
  pointer: "/steps/0/try/0",
  kind: "call",
  steps: ["task"],
  scope: [],
  call: {
    name: "grasp.model",
    binding: "m",
    instructions: { literal: "" },
    input: { literal: "" },
    outputSchema: {},
  },
};

describe("a step's failure, as a catch sees it", () => {
  it("never lets a catch take an unknown outcome or a refusal of the module", () => {
    const codes = [
      "connect.outcome_unknown",
      "connect.outcome_unknown_unresolved",
      "effect.outcome_unknown",
      "function.outcome_unknown",
      "function.sandbox_lost",
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
      { name: "Error", message: "", code: "function.deadline_exceeded" },
    ];
    expect(
      timeouts.map((error) => failureOf(error, modelTask, false).catchable)
    ).toStrictEqual([false, false]);
    // A connector call that ran out of time on every attempt: its send may
    // have gone out, and no attempt had connect's definite answer.
    const connector: SealedTask = {
      id: "send",
      pointer: "/steps/0/try/0",
      kind: "call",
      steps: ["task"],
      scope: [],
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

  it("hands a catch the failure's code and the platform's words, never the step's own message", () => {
    const caughtOf = (error: { name: string; code?: string }) => {
      const failure = failureOf(
        { ...error, message: "with data the run read" },
        task,
        false
      );
      return failure.catchable
        ? {
            code: failure.error.code,
            step: failure.error.step,
            leaks: failure.error.message.includes("data"),
          }
        : undefined;
    };
    expect({
      timeout: caughtOf({ name: "TimeoutError" }),
      denied: caughtOf({ name: "Error", code: "permission.denied" }),
      data: caughtOf({ name: "Error", code: "workflow.task_data_invalid" }),
      expression: caughtOf({ name: "Error", code: "expression.failed" }),
      connector: caughtOf({ name: "Error", code: "connect.declined" }),
      unknown: caughtOf({ name: "Error" }),
    }).toStrictEqual({
      timeout: {
        code: "function.deadline_exceeded",
        step: "send",
        leaks: false,
      },
      denied: { code: "permission.denied", step: "send", leaks: false },
      data: { code: "workflow.task_data_invalid", step: "send", leaks: false },
      expression: { code: "expression.failed", step: "send", leaks: false },
      connector: { code: "connect.declined", step: "send", leaks: false },
      unknown: { code: "internal.unexpected", step: "send", leaks: false },
    });
  });

  it("lets a retry policy try again only what trying again may fix", () => {
    expect({
      timeout: retries({ name: "TimeoutError" }, task),
      connector: retries({ name: "Error", code: "connect.unavailable" }, task),
      testRunWaitLimit: failureOf(
        { name: "Error", message: "", code: "workflow.candidate_wait_limit" },
        task,
        false
      ).catchable,
      conflict: retries({ name: "Error", code: "data.conflict" }, task),
      denied: retries({ name: "Error", code: "permission.denied" }, task),
      invalid: retries(
        { name: "Error", code: "workflow.task_data_invalid" },
        task
      ),
      modelTimedOut: retries({ name: "TimeoutError" }, modelTask),
    }).toStrictEqual({
      timeout: true,
      connector: true,
      testRunWaitLimit: false,
      conflict: false,
      denied: false,
      invalid: false,
      modelTimedOut: false,
    });
  });
});
