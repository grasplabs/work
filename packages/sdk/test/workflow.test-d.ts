// Compile-time guarantees of the workflow SDK. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an error.
/* oxlint-disable require-await -- stand-in callbacks for interfaces that take async functions */
import type { RunId } from "@grasp-os/shared/ids";
import { expectTypeOf } from "vite-plus/test";
import type { z } from "zod";

import type { stepOptionSchemas } from "../src/steps.ts";
import { v } from "../src/workflow.ts";
import type {
  DecisionOptions,
  DoOptions,
  SleepOptions,
  StepRunner,
  WorkflowContext,
} from "../src/workflow.ts";
import { invoiceWorkflow } from "./workflows/invoice-approval.ts";

const params = {
  threshold: {
    label: "Above",
    type: v.money().default({ minorUnits: 500_000, currency: "EUR" }),
  },
  reviewer: { label: "Reviewer", type: v.person().default("team:finance") },
  limit: { label: "Limit", type: v.number().integer().default(3) },
};
declare const step: StepRunner;
declare const context: WorkflowContext<typeof params, undefined>;
const { params: p } = context;

// Parameters are typed by their `v` type.
expectTypeOf(p.threshold).toEqualTypeOf<{
  currency: string;
  minorUnits: number;
}>();
expectTypeOf(p.reviewer).toEqualTypeOf<string>();
expectTypeOf(p.limit).toEqualTypeOf<number>();
expectTypeOf(context.runId).toEqualTypeOf<RunId>();

// The SDK owns how long a decision waits.
// @ts-expect-error -- a decision needs a timeout
await step.decision("review", {
  description: "Review",
  from: p.reviewer,
});

// Retries say how many, and how far apart.
await step.do(
  "match",
  // @ts-expect-error -- retries are an object
  { description: "Match", retries: 2 },
  async () => 1
);
await step.do(
  "match",
  {
    description: "Match",
    retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    timeout: "30 seconds",
  },
  async () => 1
);

// A step's result is JSON, which the engine records.
await step.do(
  "when",
  { description: "When" },
  // @ts-expect-error -- a Date isn't JSON
  async () => new Date(0)
);

// The typed options and the schemas that check them at run time take the
// same options.
// But for `retry`, generated code's alone, checked apart.
expectTypeOf<Exclude<keyof DoOptions, "retry">>().toEqualTypeOf<
  keyof z.input<typeof stepOptionSchemas.do>
>();
expectTypeOf<keyof DecisionOptions>().toEqualTypeOf<
  keyof z.input<typeof stepOptionSchemas.decision>
>();
expectTypeOf<keyof SleepOptions>().toEqualTypeOf<
  keyof z.input<typeof stepOptionSchemas.sleep>
>();

// Every step needs a description.
// @ts-expect-error -- the description is required
await step.do("match", {}, async () => 1);
// @ts-expect-error -- the description is required
await step.sleep("pause", { duration: "1 day" });
// @ts-expect-error -- durations need a unit
await step.sleep("pause", { description: "Pause", duration: "1 fortnight" });

// A step gets back the input it's given, as typed, and input is JSON.
await step.do(
  "notify",
  { description: "Notify", input: { to: "anna", count: 2 } },
  async ({ input }) => {
    expectTypeOf(input).toEqualTypeOf<{ to: string; count: number }>();
  }
);
await step.do("match", { description: "Match" }, async ({ input }) => {
  expectTypeOf(input).toBeUndefined();
});
await step.do(
  "match",
  // @ts-expect-error -- input is JSON
  { description: "Match", input: { at: new Date(0) } },
  async () => 1
);

// A run resolves to what the workflow returns.
expectTypeOf(
  invoiceWorkflow({
    findPurchaseOrder: async () => null,
    book: async () => "",
  }).run
).returns.resolves.toExtend<{
  status: "unmatched" | "rejected" | "timedOut" | "booked";
}>();
