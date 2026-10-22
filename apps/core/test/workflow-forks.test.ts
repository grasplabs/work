/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { describe, expect, it } from "vite-plus/test";

import { withCpuKills } from "./cpu-kills.ts";
import {
  builder,
  codeOf,
  completedSteps,
  endOf,
  hostOf,
  objectSchema,
  published,
  ranFor,
} from "./json-workflows.ts";

// `fork` tasks of JSON workflows (GRA-276; @grasp-os/open-workflow's
// generate.ts, the SDK's open-workflow.ts and core's resource-host.ts), run
// one branch after another (concurrency 1, until GRA-956), from their
// threat model: a branch sees the context as the fork found it, never
// another branch's exports, and none reaches the fork's own context; a
// fork's output is its branches' outputs in declaration order; a race
// (`compete: true`) records the first branch that succeeds, never admits
// a branch after it, and doesn't claim a failed branch's completed effects
// were undone; a replay or a killed attempt takes the recorded winner and
// runs no branch's step again; and each branch's steps are its own
// (`task:<id>@<fork>.<branch>`), only of a branch the fork has.

/** Starts the context with `value`. */
const initially = (value: string) => ({
  init: { set: "${ . }", export: { as: value } },
});

/** A branch `id` that sets `value`, exporting `exported` if given. */
const branch = (id: string, value: string, exported?: string) => ({
  [id]: {
    set: value,
    ...(exported === undefined ? {} : { export: { as: exported } }),
  },
});

/** A branch `id` whose output breaks its schema: it fails for good. */
const failing = (id: string) => ({
  [id]: {
    set: "${ {other: 1} }",
    output: { schema: objectSchema({ status: { type: "string" } }) },
  },
});

/** A race of `branches`, its winner's status, then the context's `marks`. */
const race = (branches: unknown[]) => [
  initially("${ {marks: 0} }"),
  { pick: { fork: { branches, compete: true } } },
  {
    finished: {
      set: '${ {status: (.status + ":" + ($context.marks | tostring))} }',
    },
  },
];

describe("fork tasks of JSON workflows", { timeout: 60_000 }, () => {
  it("run every branch from the context the fork found, and answer their outputs in declaration order", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, [
      initially("${ {n: 1} }"),
      {
        both: {
          fork: {
            branches: [
              // Its export is its own: neither the next branch nor the
              // fork's context sees it.
              branch("first", "${ {v: ($context.n + 1)} }", "${ {n: 100} }"),
              branch("second", "${ {v: ($context.n + 2)} }"),
            ],
          },
          output: { as: '${ {status: (map(.v | tostring) | join(","))} }' },
        },
      },
      {
        finished: {
          set: '${ {status: (.status + ":" + ($context.n | tostring))} }',
        },
      },
    ]);
    expect({
      executable: version.build.executable,
      end: endOf(await ranFor(by, workflow.id)),
    }).toStrictEqual({
      executable: true,
      end: { status: "completed", output: { status: "2,3:1" } },
    });
  });

  it("leave a branch at its exit, and the workflow at an end in a branch", async () => {
    const by = await builder();
    /** A fork whose branch is a list that leaves early by `then`. */
    const leaving = (then: string) => [
      {
        both: {
          fork: {
            branches: [
              {
                early: {
                  do: [
                    { mark: { set: '${ {status: "left"} }', then } },
                    { never: { set: '${ {status: "never"} }' } },
                  ],
                },
              },
              branch("other", '${ {status: "other"} }'),
            ],
          },
          output: { as: '${ {status: (map(.status) | join(","))} }' },
        },
      },
      { finished: { set: '${ {status: (.status + "!")} }' } },
    ];
    const exited = await published(by, leaving("exit"));
    const ended = await published(by, leaving("end"));
    const endedRun = await ranFor(by, ended.workflow.id);
    const completed = await completedSteps(endedRun.id);
    expect({
      exited: endOf(await ranFor(by, exited.workflow.id)),
      ended: endOf(endedRun),
      // The branch after the one that ended the workflow never started.
      after: completed.get("task:other@both.1") ?? 0,
    }).toStrictEqual({
      exited: { status: "completed", output: { status: "left,other!" } },
      ended: { status: "completed", output: { status: "left" } },
      after: 0,
    });
  });

  it("race: record the first branch that succeeds, and never run a branch after it", async () => {
    const by = await builder();
    const { workflow } = await published(
      by,
      race([
        failing("broken"),
        branch(
          "winner",
          '${ {status: "won"} }',
          "${ {marks: ($context.marks + 1)} }"
        ),
        branch("late", '${ {status: "late"} }'),
      ])
    );
    const run = await ranFor(by, workflow.id);
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      raced: completed.get("task:pick") ?? 0,
      winner: completed.get("task:winner@pick.1") ?? 0,
      late: completed.get("task:late@pick.2") ?? 0,
    }).toStrictEqual({
      // The winner's output; its export stays its own.
      end: { status: "completed", output: { status: "won:0" } },
      raced: 1,
      winner: 1,
      late: 0,
    });
  });

  it("race: fail when every branch fails, as the last one did", async () => {
    const by = await builder();
    const { workflow } = await published(
      by,
      race([failing("one"), failing("two")])
    );
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "failed",
      code: "workflow.task_data_invalid",
    });
  });

  it("race: keep its recorded winner across a replay after a wait and a killed attempt, running no branch again", async () => {
    const by = await builder();
    const { workflow } = await published(
      by,
      race([
        failing("broken"),
        {
          slow: {
            do: [
              { roll: { call: "grasp.random" } },
              // A new activation: the branches before replay.
              { pause: { wait: "PT1S" } },
              { done: { set: '${ {status: "slow"} }' } },
            ],
          },
        },
        branch("late", '${ {status: "late"} }'),
      ])
    );
    // The race's record is lost once, its first attempt cut off as its
    // code returned: its retry takes the same winner.
    const run = await withCpuKills(
      "task:pick",
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id),
      "end"
    );
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      rolled: completed.get("task:roll@pick.1") ?? 0,
      raced: completed.get("task:pick") ?? 0,
      late: completed.get("task:late@pick.2") ?? 0,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "slow:0" } },
      rolled: 1,
      raced: 1,
      late: 0,
    });
  });
});

const ada = { input: { input: { who: "Ada" }, context: {} } };

/** A race of two branches, for the forged modules below. */
const twoWay = [
  {
    pick: {
      fork: {
        branches: [
          branch("left", '${ {status: "left"} }'),
          branch("right", '${ {status: "right"} }'),
        ],
        compete: true,
      },
    },
  },
];

describe("a run's host, against a forged module's fork", () => {
  it("runs a branch's steps only in a branch the fork has, and records only a winner it has", async () => {
    const by = await builder();
    const { workflow } = await published(by, twoWay);
    /** Step `name` recording `value`, on a fresh host. */
    const forged = async (name: string, value: unknown) => {
      const host = await hostOf(by, workflow.id);
      return codeOf(
        await host.do(name, ada, async () => {
          await Promise.resolve();
          return { ok: true, value };
        })
      );
    };
    /** The race step settling on `branch`, recording `recorded` of it. */
    const settling = async (
      which: number,
      recorded: (settled: unknown) => unknown
    ) => {
      const host = await hostOf(by, workflow.id);
      return codeOf(
        await host.do("task:pick", ada, async (attempt) => {
          const settled = await attempt.settle({ branch: which });
          return {
            ok: true,
            value: {
              output: null,
              branch: recorded(settled.ok ? settled.value : null),
            },
          };
        })
      );
    };
    expect({
      inBranch: await forged("task:right@pick.1", {
        output: { status: "right" },
      }),
      pastBranches: await forged("task:right@pick.2", {
        output: { status: "right" },
      }),
      otherBranchTask: await forged("task:right", {
        output: { status: "right" },
      }),
      // A race's record names the branch the host settled it on.
      winner: await settling(1, (settled) => settled),
      otherWinner: await settling(1, () => 0),
      noSuchWinner: await settling(2, (settled) => settled),
      unsettled: await forged("task:pick", { output: null, branch: 1 }),
    }).toStrictEqual({
      inBranch: "ok",
      pastBranches: "workflow.invalid",
      otherBranchTask: "workflow.invalid",
      winner: "ok",
      otherWinner: "workflow.invalid",
      noSuchWinner: "workflow.invalid",
      unsettled: "workflow.invalid",
    });
  });
});
