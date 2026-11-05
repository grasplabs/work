import { openWorkflowEntry } from "@grasp-os/compiler";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  checked,
  decision,
  emojiType,
  everyBinding,
  eventWait,
  everyOperator,
  everyStep,
  withDecisions,
  withEventWaits,
  withLoops,
} from "../../../packages/workflow-schema/test/fixtures.ts";
import { buildOpenWorkflow } from "../src/screens.ts";
import { tasksFileSchema } from "../src/workflow-builds.ts";

// grasp-workflow/1's generated code, held to the compiler's own type
// check against the SDK's real declarations, as the host's generated
// workflow module is built (`buildOpenWorkflow`): the generator's output
// is the host's own, so a type error in it is the generator's, and
// nothing it generates may fail the check a build holds it to. Its sealed
// table, likewise, is one the host reads back (`tasksFileSchema`).

/** Every fixture the generator is tested on, by name. */
const fixtures = {
  everyStep,
  everyBinding,
  everyOperator,
  decisions: () =>
    withDecisions(
      decision(),
      decision({
        id: "later",
        if: { $expr: "steps.approve.output.timedOut" },
        recipients: { $expr: "[input.who]" },
        timeout: "2 days",
      })
    ),
  // A decision in items, its loop stopped by a `while`, beside nested loops.
  loops: () => ({
    ...withLoops({
      id: "approvals",
      type: "forEach",
      items: { $expr: "input.pages" },
      while: { $expr: "item.open" },
      do: [
        decision({ recipients: [{ $expr: "item.owner" }] }),
        {
          id: "refused",
          type: "raise",
          if: { $expr: "!steps.approve.output.approved" },
          error: { type: "urn:grasp:error:refused", status: 409 },
        },
      ],
    }),
    bindings: withDecisions().bindings,
  }),
  // Event waits, one in a loop's items, and steps reading how they ended.
  eventWaits: () =>
    withEventWaits(
      eventWait({ if: { $expr: 'input.who !== "Ada"' } }),
      {
        id: "answer",
        type: "do",
        binding: "mail",
        operation: "mail.send",
        if: { $expr: "!steps.reply.output.timedOut" },
        arguments: {
          to: { $expr: "steps.reply.output.event.data.from" },
          subject: { $expr: "steps.reply.output.event.type" },
        },
      },
      {
        id: "rounds",
        type: "forEach",
        items: { $expr: "input.rounds" },
        do: [
          eventWait({
            id: "each",
            event: { from: "replies", type: ["grasp.a", "grasp.b"] },
          }),
        ],
      }
    ),
};

/** A workflow waiting for an event of `type` through `replies`. */
const waitingFor = (type: string) =>
  withEventWaits(eventWait({ event: { from: "replies", type } }));

describe("grasp-workflow/1's generated code", () => {
  it("type-checks against the SDK, for every fixture", async () => {
    const diagnostics = Object.fromEntries(
      await Promise.all(
        Object.entries(fixtures).map(
          async ([name, fixture]): Promise<[string, string[]]> => {
            const { source } = generateWorkflow(
              checked(fixture()),
              "generated"
            );
            const build = await buildOpenWorkflow(
              env,
              { [openWorkflowEntry]: source },
              "workflow-schema-builds"
            );
            return [
              name,
              build.ok
                ? []
                : build.diagnostics.map(
                    ({ rule, line, message }) => `${rule} ${line}: ${message}`
                  ),
            ];
          }
        )
      )
    );
    expect(diagnostics).toStrictEqual(
      Object.fromEntries(Object.keys(fixtures).map((name) => [name, []]))
    );
  });

  it("seals a table the host reads back, for every fixture", () => {
    const refused = Object.entries(fixtures).flatMap(([name, fixture]) => {
      const generation = generateWorkflow(checked(fixture()), "generated");
      const read = tasksFileSchema.safeParse(
        structuredClone({
          tasks: generation.tasks,
          expressions: generation.expressions,
          workflow: generation.workflow,
          params: generation.params,
          limits: generation.limits,
        })
      );
      return read.success ? [] : [[name, read.error.issues]];
    });
    expect(refused).toStrictEqual([]);
  });

  it("holds an event type to one length, in code points, from the check to the sealed table", () => {
    const longest = emojiType(sealedBuildLimits.eventTypeLength);
    const tooLong = emojiType(sealedBuildLimits.eventTypeLength + 1);
    const generation = generateWorkflow(
      checked(waitingFor(longest)),
      "generated"
    );
    const sealed = JSON.stringify({
      tasks: generation.tasks,
      expressions: generation.expressions,
      workflow: generation.workflow,
      params: generation.params,
      limits: generation.limits,
    });
    expect({
      longest: tasksFileSchema.safeParse(JSON.parse(sealed)).success,
      tooLongChecked: checkWorkflow(waitingFor(tooLong)).ok,
      // That table with one more emoji in its type: what a checker counting
      // length otherwise than the host would have let through.
      tooLongSealed: tasksFileSchema.safeParse(
        JSON.parse(sealed.replaceAll(longest, tooLong))
      ).success,
    }).toStrictEqual({
      longest: true,
      tooLongChecked: false,
      tooLongSealed: false,
    });
  });
});
