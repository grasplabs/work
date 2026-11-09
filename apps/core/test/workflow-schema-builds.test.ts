import { generatedWorkflowEntry } from "@grasp-os/compiler";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { sealedTableSchema } from "@grasp-os/workflow-schema/sealed";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  checked,
  decision,
  emojiType,
  everyCall,
  eventWait,
  everyOperator,
  everyStep,
  followedBy,
  keeping,
  withDecisions,
  withEventWaits,
  withLoops,
} from "../../../packages/workflow-schema/test/fixtures.ts";
import { buildGeneratedWorkflow } from "../src/pages.ts";

// grasp-workflow/2's generated code, held to the compiler's own type
// check against the SDK's real declarations, as the host's generated
// workflow module is built (`buildGeneratedWorkflow`): the generator's
// output is the host's own, so a type error in it is the generator's, and
// nothing it generates may fail the check a build holds it to. Its sealed table, likewise, is one the
// host reads back (`sealedTableSchema`).

/** Every fixture the generator is tested on, by name. */
const fixtures = {
  everyStep,
  everyCall,
  everyOperator,
  decisions: () =>
    withDecisions(
      decision(),
      decision({
        id: "later",
        if: { $expr: "approve.timedOut" },
        recipients: { $expr: "[args.who]" },
        timeout: "2 days",
      })
    ),
  // A decision in items, its loop stopped by a `while`, beside nested loops.
  loops: () => ({
    ...withLoops({
      id: "approvals",
      type: "forEach",
      items: { $expr: "args.pages" },
      while: { $expr: "item.open" },
      do: [
        decision({ recipients: [{ $expr: "item.owner" }] }),
        {
          id: "refused",
          type: "raise",
          if: { $expr: "!approve.approved" },
          error: { code: "test.refused", message: "Failed." },
        },
      ],
    }),
    permissions: withDecisions().permissions,
  }),
  // A loop's item read bare, as arithmetic takes it, in nested loops.
  bareItems: () =>
    withLoops({
      id: "scores",
      type: "forEach",
      items: { $expr: "args.pages" },
      do: [
        {
          id: "marks",
          type: "forEach",
          items: { $expr: "item.marks" },
          while: { $expr: "100 * item < 5000" },
          do: [{ id: "tick", type: "wait", for: "1 second" }],
        },
      ],
    }),
  // Event waits, one in a loop's items, and steps reading how they ended.
  // A mail whose replies go to the run's inbox, a string or `undefined`,
  // and the wait that takes the reply.
  inbox: () =>
    withEventWaits(
      {
        id: "ask",
        type: "call",
        connection: "mail",
        action: "mail.send",
        if: { $expr: 'typeof inbox.replies === "string"' },
        args: {
          to: { $expr: "args.who" },
          subject: { $expr: '"Reply to " + (inbox.replies ?? "")' },
          replyTo: { $expr: "inbox.replies" },
        },
      },
      eventWait()
    ),
  eventWaits: () =>
    withEventWaits(
      eventWait({ if: { $expr: 'args.who !== "Ada"' } }),
      {
        id: "answer",
        type: "call",
        connection: "mail",
        action: "mail.send",
        if: { $expr: "!reply.timedOut" },
        args: {
          to: { $expr: "reply.event.data.from" },
          subject: { $expr: "reply.event.type" },
        },
      },
      {
        id: "rounds",
        type: "forEach",
        items: { $expr: "args.rounds" },
        do: [
          eventWait({
            id: "each",
            eventType: ["grasp.a", "grasp.b"],
          }),
        ],
      }
    ),
  // State kept by a call (a count of runs among it), an `if`-guarded one
  // and one in a loop's items, read by an agent's instructions.
  state: () =>
    followedBy(
      keeping(),
      keeping({ id: "maybe", if: { $expr: "args.who === state.last" } }),
      {
        id: "rows",
        type: "forEach",
        items: { $expr: "state.kept" },
        do: [keeping({ id: "row", state: { last: { $expr: "item" } } })],
      },
      {
        id: "ask",
        type: "generate",
        instructions: { $expr: '"Runs so far: " + (state.runs ?? 0)' },
        input: { last: { $expr: "state.last" } },
        returns: { kind: "string" },
        state: { last: { $expr: "output" } },
      }
    ),
};

/** A workflow waiting for an event of `type` through `replies`. */
const waitingFor = (type: string) =>
  withEventWaits(eventWait({ eventType: type }));

describe("grasp-workflow/2's generated code", () => {
  it("type-checks against the SDK, for every fixture", async () => {
    const diagnostics = Object.fromEntries(
      await Promise.all(
        Object.entries(fixtures).map(
          async ([name, fixture]): Promise<[string, string[]]> => {
            const { source } = generateWorkflow(checked(fixture()));
            const build = await buildGeneratedWorkflow(
              env,
              { [generatedWorkflowEntry]: source },
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
      const generation = generateWorkflow(checked(fixture()));
      const read = sealedTableSchema.safeParse(
        structuredClone({
          tasks: generation.tasks,
          expressions: generation.expressions,
          workflow: generation.workflow,
          params: generation.params,
        })
      );
      return read.success ? [] : [[name, read.error.issues]];
    });
    expect(refused).toStrictEqual([]);
  });

  it("holds an event type to one length, in code points, from the check to the sealed table", () => {
    const longest = emojiType(sealedBuildLimits.eventTypeLength);
    const tooLong = emojiType(sealedBuildLimits.eventTypeLength + 1);
    const generation = generateWorkflow(checked(waitingFor(longest)));
    const sealed = JSON.stringify({
      tasks: generation.tasks,
      expressions: generation.expressions,
      workflow: generation.workflow,
      params: generation.params,
    });
    expect({
      longest: sealedTableSchema.safeParse(JSON.parse(sealed)).success,
      tooLongChecked: checkWorkflow(waitingFor(tooLong)).ok,
      // That table with one more emoji in its type: what a checker counting
      // length otherwise than the host would have let through.
      tooLongSealed: sealedTableSchema.safeParse(
        JSON.parse(sealed.replaceAll(longest, tooLong))
      ).success,
    }).toStrictEqual({
      longest: true,
      tooLongChecked: false,
      tooLongSealed: false,
    });
  });
});
