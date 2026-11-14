// Compile-time guarantees of the workflow SDK. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an error.
/* oxlint-disable require-await -- stand-in handlers for an interface that takes async functions */
import { expectTypeOf } from "vite-plus/test";

import { defineWorkflow, v } from "../src/workflow.ts";
import type {
  BrainSkill,
  ConnectionMembers,
  WorkflowCtx,
  WorkflowPermissions,
} from "../src/workflow.ts";

const permissions = {
  ai: true,
  connections: {
    mail: { send: "mail.send", "send-invite": "mail.send-invite" },
    github: { "issues.create": "issues.create" },
  },
  decisions: ["finance"],
  events: { stripe: ["invoice.paid", "invoice.failed"] },
  brain: { handbook: ["recall", "skills.select"] },
} as const satisfies WorkflowPermissions;

const params = {
  threshold: { label: "Above", type: v.number().default(100) },
};

declare const ctx: WorkflowCtx<typeof permissions, typeof params>;

// Every declared action is a member, by its dotted path, `-` in camel case.
expectTypeOf(ctx.connections.mail.send).toBeFunction();
expectTypeOf(ctx.connections.mail.sendInvite).toBeFunction();
expectTypeOf(ctx.connections.github.issues.create).toBeFunction();
expectTypeOf(ctx.decisions.finance.ask).toBeFunction();
expectTypeOf(ctx.ai.generate).toBeFunction();
expectTypeOf(ctx.params.threshold).toEqualTypeOf<number>();
// The Brain's actions: `recall` itself, its skills under `skills`.
expectTypeOf(ctx.brain.handbook.recall).toBeFunction();
expectTypeOf(
  ctx.brain.handbook.skills.select({ task: "refunds" }, { step: "skills" })
).resolves.toEqualTypeOf<{ readonly skills: readonly BrainSkill[] }>();
// @ts-expect-error -- no step reads a skill
expectTypeOf(ctx.brain.handbook.skills.read).toBeFunction();

// A name nobody declared is no member.
// @ts-expect-error -- no such connection
expectTypeOf(ctx.connections.slack).toBeObject();
// @ts-expect-error -- no such action
expectTypeOf(ctx.connections.github.repos).toBeObject();
// @ts-expect-error -- no such decision
expectTypeOf(ctx.decisions.legal).toBeObject();

// An event wait takes only the types its permission declares.
void ctx.events.stripe.waitFor(
  { type: "invoice.paid", timeout: "3 days" },
  { step: "paid" }
);
void ctx.events.stripe.waitFor(
  // @ts-expect-error -- not one of the declared types
  { type: "invoice.created", timeout: "3 days" },
  { step: "created" }
);

// Every call names its step.
// @ts-expect-error -- no step
void ctx.connections.mail.send({ to: "ada" });

// A workflow with no model has no `ai`.
declare const noModel: WorkflowCtx<
  { connections: { mail: { send: "mail.send" } } },
  Record<never, never>
>;
expectTypeOf(noModel.ai).toEqualTypeOf<undefined>();

// Members are typed from the declaration, path by path.
expectTypeOf<ConnectionMembers<"a.b" | "a.c">>().toHaveProperty("a");

// The handler's args are what `args` declares.
defineWorkflow({
  args: v.object({ who: v.string() }),
  handler: async (_ctx, args) => {
    expectTypeOf(args.who).toEqualTypeOf<string>();
    return null;
  },
});
