import { valueDepth } from "@grasp-os/shared/value-depth";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowDuration } from "@grasp-os/workerflow/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { connectModels } from "./model-provider.ts";
import { admittedFreely } from "./runs.ts";
import {
  anyText,
  checkedCalls,
  failedWith,
  journalingEngine,
  moduleOf,
  objectOf,
  ranAs,
  refusedAs,
  retryingEngine,
  sealedWorkflow,
  serving,
  standardErrors,
  waitingRun,
  allowedModel,
} from "./sealed-run-harness.ts";
import type { Engine, Journaled, Sealed, Tries } from "./sealed-run-harness.ts";
import { taskStep } from "./sealed-runs.ts";

/** `levels` lists around a text, as a module's expression. */
const nestedIn = (levels: number): string =>
  `Array.from({ length: ${levels} }).reduce((inner) => [inner], "x")`;

/** Try `id`'s catch step, deciding by `takes`. */
const catchStep = (id: string, takes: string): string =>
  `await step.caught(${JSON.stringify(id)}, { key: "catch", description: "Its catch" }, ${takes})`;

/** The error `stop` raises, as a catch takes it. */
const stopped = {
  type: "urn:grasp:error:stop",
  status: 422,
  instance: "/steps/6/try/0/try/0",
  title: "Stopped.",
};

/** `pause`'s enter step, recording the deadline `until`, as `until`. */
const enterPause = (until: string): string =>
  `const { until } = await step.do("pause", { key: "enter", description: "Its start" }, async () => ({ output: null, until: ${until} }));`;

/** `pause`'s sleep, until `until`. */
const sleepPause = (until: string): string =>
  `await step.sleepUntil("pause", { key: "task", description: "Its sleep", until: ${until} });`;

/** A retry choice naming `by`'s catch, retrying. */
const retryingBy = (by: string): string =>
  `, retry: async () => ({ by: ${JSON.stringify(by)}, retry: true })`;

/** The engine's steps, by key, that a retry of `fetch` ran of `part`. */
const retrySteps = (tries: Tries, part: "decide" | "run"): number =>
  [...tries.keys()].filter(
    (key) =>
      key.startsWith("key:$grasp:wait:") &&
      key.includes(`:retry:`) &&
      key.endsWith(`:${part}`)
  ).length;

// The ways a catch, a raise, a retry or a sleep can fail a sealed run's
// security, each refused or held by the host: a catch taking what its
// sealed filter or the host's mapping doesn't let it, or what it wasn't
// offered; code relabelling the host's failure of its call; a run going
// on past a failure no catch took; a raise run as anything but its sealed
// error; a retry past its policy's rounds, or chosen by a catch that
// can't take the failure; a sleep of another length, or until another
// deadline than the one recorded; an attempt longer than its policy lets.
describe("a sealed run's catches, raises, retries and sleeps on the run host", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    // The model its workflow binds, chosen as the build's run tests
    // choose it (sealed-runs.test.ts): this file starts from empty storage.
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    sealed = await sealedWorkflow();
  });

  // Each test's waiting runs end with it: a person's runs of one
  // workflow under way are bounded.
  afterEach(endLiveResourceRuns);

  it("fails a raise with its sealed error, which only a catch whose filter it has takes", async () => {
    const caught = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
const asked = [];
try {
  try {
    ${taskStep("stop", "{ output: null }")};
  } catch (thrown) {
    const inner = ${catchStep("inner", 'async () => { asked.push("inner"); return true; }')};
    if (inner === undefined) throw thrown;
    return { inner };
  }
} catch (thrown) {
  const outer = ${catchStep("outer", "async (error) => { asked.push(error); return true; }")};
  if (outer === undefined) throw thrown;
  return { outer, asked };
}`)
    );
    const uncaught = await ranAs(
      await waitingRun(sealed),
      moduleOf(`return ${taskStep("stop", "{ output: null }")};`)
    );
    const skipped = await ranAs(
      await waitingRun(sealed),
      moduleOf(`return ${taskStep("stop", "{ skipped: true }")};`)
    );
    // Its code throws rather than records: its sealed error all the same.
    const thrown = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("stop", '(() => { throw new Error("not raised"); })()')};`
      )
    );
    // Its code rejects as the Loader's CPU kill would: its sealed error.
    const cutOff = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("stop", '(() => { throw { get name() { throw new Error("Worker exceeded CPU time limit."); } }; })()')};`
      )
    );
    // A catch further in with no conditions takes it: one further out,
    // asked in its place, is offered nothing.
    const passedOver = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("boom", "{ output: null }")};
} catch (thrown) {
  return { caught: (${catchStep("wrapped", "async () => true")}) ?? null };
}`)
    );
    expect({
      caught,
      uncaught,
      skipped,
      thrown,
      cutOff,
      passedOver,
    }).toStrictEqual({
      caught: {
        ended: { outer: stopped, asked: [stopped] },
        tampered: [],
      },
      uncaught: failedWith("workflow.raised"),
      skipped: { ended: { skipped: true }, tampered: [] },
      thrown: failedWith("workflow.raised"),
      cutOff: failedWith("workflow.raised"),
      passedOver: {
        ended: { caught: null },
        tampered: [],
        untaken: "workflow.raised",
      },
    });
  });

  it("refuses a run that goes on past a failure no catch took, and a catch that takes what it wasn't offered", async () => {
    const swallowed = `try { ${taskStep("stop", "{ output: null }")}; } catch {}`;
    const nextStep = await ranAs(
      await waitingRun(sealed),
      moduleOf(`${swallowed} return ${taskStep("finish", "{ output: null }")};`)
    );
    const ended = await ranAs(
      await waitingRun(sealed),
      moduleOf(`${swallowed} return "done";`)
    );
    const forged = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `try { ${taskStep("stop", "{ output: null }")}; } catch { return ${catchStep("outer", 'async () => "yes"')}; }`
      )
    );
    const asDo = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return await step.do("outer", { key: "catch", description: "Its catch" }, async () => true);`
      )
    );
    expect({ nextStep, ended, forged, asDo }).toStrictEqual({
      nextStep: refusedAs(
        "A run goes on past a failure only once a catch took it."
      ),
      ended: { ended: "done", tampered: [], untaken: "workflow.raised" },
      forged: refusedAs("A catch takes only the error it was offered."),
      asDo: refusedAs(`Step "outer:catch" isn't one the build seals.`),
    });
  });

  it("fails an attempt with the host's failure of its call, whatever its code makes of it, and takes a failure only its code reports as the task's own", async () => {
    const revoking = await sealedWorkflow();
    const swallowing = await waitingRun(revoking);
    const rejecting = await waitingRun(revoking);
    await revokeWorkflowBinding(
      serving,
      revoking.admin,
      revoking.workflow.id,
      revoking.approval.id
    );
    const swallowed = await ranAs(
      swallowing,
      moduleOf(`
try {
  return ${taskStep("fetch", '(async () => { try { await env.mail.call("mail.send", { to: input.who, subject: "x" }); } catch {} return { output: "sent" }; })()')};
} catch (thrown) {
  const error = ${catchStep("guarded", "async () => true")};
  return { code: thrown.code, caught: error !== undefined };
}`)
    );
    // Its step's function rejects rather than reporting, as code that
    // throws what can't be described makes it, and as the Loader's CPU
    // kill would (a task in no try, which nothing retries).
    const rejected = await ranAs(
      rejecting,
      moduleOf(`
try {
  return ${taskStep("send", '(async () => { try { await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); } catch {} throw { get name() { throw new Error("Worker exceeded CPU time limit."); } }; })()')};
} catch (thrown) {
  return { code: thrown.code };
}`)
    );
    // Its call took effect, then its code failed: no catch takes that.
    const afterEffect = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(async () => { await env.mail.call("mail.send", { to: input.who, subject: "x" }); throw new Error("after"); })()')};
} catch (thrown) {
  return { code: thrown.code, caught: (${catchStep("guarded", "async () => true")}) ?? null };
}`)
    );
    // Its call took effect, then its lineage had no host call left for a
    // next one: it failed after its effect all the same.
    let hostCalls = 0;
    const spentAfter = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(async () => { await env.mail.call("mail.send", { to: input.who, subject: "x" }); await env.mail.call("mail.send", { to: input.who, subject: "x" }).catch(() => null); return { output: "sent" }; })()')};
} catch (thrown) {
  return { code: thrown.code, caught: (${catchStep("guarded", "async () => true")}) ?? null };
}`),
      {
        admitAttempt: () => async () => ({
          ...(await admittedFreely()),
          hostCall: async () => {
            hostCalls += 1;
            if (hostCalls > 1) {
              throw workflowErrors.create("workflow.lineage_limit");
            }
            await Promise.resolve();
          },
        }),
      }
    );
    const relabelled = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(() => { const error = new Error("Execution timed out, CPU time limit"); error.code = "connect.outcome_unknown"; throw error; })()')};
} catch (thrown) {
  return { code: thrown.code ?? null, caught: ${catchStep("guarded", "async () => true")} };
}`)
    );
    expect({
      swallowed,
      rejected,
      afterEffect,
      spentAfter,
      relabelled,
    }).toStrictEqual({
      swallowed: {
        ended: { code: "workflow.call_denied", caught: true },
        tampered: [],
      },
      rejected: {
        ended: { code: "workflow.call_denied" },
        tampered: [],
        untaken: "workflow.call_denied",
      },
      afterEffect: {
        ended: { code: "workflow.failed_after_effect", caught: null },
        tampered: [],
        untaken: "workflow.failed_after_effect",
      },
      spentAfter: {
        ended: { code: "workflow.failed_after_effect", caught: null },
        tampered: [],
        untaken: "workflow.failed_after_effect",
      },
      relabelled: {
        ended: {
          code: "internal.unexpected",
          caught: {
            type: `${standardErrors}runtime`,
            status: 500,
            instance: "/steps/5/try/0",
            title: "Something went wrong.",
          },
        },
        tampered: [],
      },
    });
  });

  it("fails a call its run's data nests past 34 levels as its step's own failure, which a catch takes, and refuses a forged deep literal or slot", async () => {
    // Its `rows` slot is three levels into the arguments, so an
    // evaluation's result there, at most 32 deep, may nest them 35 levels
    // deep; its `who` slot is two levels in.
    const whoInput = { $expr: "input.who" };
    const deep = await sealedWorkflow([
      {
        id: "careful",
        type: "try",
        try: [
          {
            id: "ask",
            type: "agent",
            binding: "summary",
            instructions: "Sum up.",
            input: { who: whoInput, rows: [whoInput] },
            output: objectOf({ line: { kind: "string" } }),
          },
        ],
        catch: { errors: { type: `${standardErrors}validation` } },
      },
    ]);
    /** `ask`'s step, sending `instructions`, `who` and a row `levels` deep. */
    const ask = ({
      instructions = '"Sum up."',
      who = "input.who",
      levels = 1,
    }: {
      instructions?: string;
      who?: string;
      levels?: number;
    }) =>
      taskStep(
        "ask",
        `(async () => ({ output: await env.summary.call("grasp.model", { instructions: ${instructions}, input: { who: ${who}, rows: [${nestedIn(levels)}] } }) }))()`
      );
    const tooDeepRun = await waitingRun(deep);
    const tooDeep = await ranAs(
      tooDeepRun,
      moduleOf(`
try {
  return ${ask({ levels: valueDepth })};
} catch (thrown) {
  return { code: thrown.code, caught: (${catchStep("careful", "async () => true")}) ?? null };
}`)
    );
    // Each as deep as the `rows` slot may nest the arguments, so only
    // matching them against the sealed template tells them from the run's
    // data: a literal the build didn't seal, and a slot holding more than
    // an evaluation can answer.
    const forgedLiteral = await ranAs(
      await waitingRun(deep),
      moduleOf(`return ${ask({ instructions: nestedIn(valueDepth + 2) })};`)
    );
    const forgedSlot = await ranAs(
      await waitingRun(deep),
      moduleOf(`return ${ask({ who: nestedIn(valueDepth + 1) })};`)
    );
    const forgedDeeper = await ranAs(
      await waitingRun(deep),
      moduleOf(`return ${ask({ instructions: nestedIn(40) })};`)
    );
    expect({
      tooDeep,
      checked: await checkedCalls(tooDeepRun),
      forgedLiteral,
      forgedSlot,
      forgedDeeper,
    }).toStrictEqual({
      tooDeep: {
        ended: {
          code: "workflow.arguments_too_deep",
          caught: {
            type: `${standardErrors}validation`,
            status: 400,
            instance: anyText,
            title:
              "This step's arguments are nested deeper than 34 levels, so its call wasn't made.",
          },
        },
        tampered: [],
      },
      checked: [],
      forgedLiteral: refusedAs(
        "arguments.instructions isn't the value the build sealed."
      ),
      forgedSlot: refusedAs(
        "arguments.input.who nests deeper than an expression's result may."
      ),
      forgedDeeper: refusedAs(
        "A call sends its operation and JSON arguments within a step's size and the depth its build allows."
      ),
    });
  });

  it("runs a step again under its catch's retry policy, held to its rounds and its attempts' duration", async () => {
    const tries: Tries = new Map();
    const timeouts = new Map<string, number | WorkflowDuration | undefined>();
    const third = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
let rounds = 0;
return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()', retryingBy("guarded"))};`),
      { engine: retryingEngine(tries, timeouts) }
    );
    const thirdSteps = {
      decided: retrySteps(tries, "decide"),
      ran: retrySteps(tries, "run"),
      timeout: timeouts.get("key:fetch:task"),
    };
    // Its policy has no conditions: it retries with no retry function.
    const withheld = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
let rounds = 0;
return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()')};`),
      { engine: retryingEngine() }
    );
    const always = new Map<string, number>();
    const never = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { throw new Error("never"); })()', retryingBy("guarded"))};`
      ),
      { engine: retryingEngine(always) }
    );
    expect({
      third,
      withheld,
      thirdSteps,
      never,
      neverRan: retrySteps(always, "run"),
    }).toStrictEqual({
      third: { ended: { output: 3 }, tampered: [] },
      withheld: { ended: { output: 3 }, tampered: [] },
      thirdSteps: { decided: 2, ran: 2, timeout: 20_000 },
      // Its policy's three rounds, then the failure goes on.
      never: failedWith("internal.unexpected"),
      neverRan: 2,
    });
  });

  it("retries nothing a retry may not fix, and what a policy with no conditions retries whatever its code chooses", async () => {
    const asked = new Map<string, number>();
    const notTransient = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { const error = new Error("bad"); error.code = "expression.failed"; throw error; })()', retryingBy("guarded"))};`
      ),
      { engine: retryingEngine(asked) }
    );
    const wrongCatch = new Map<string, number>();
    const forged = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { throw new Error("again"); })()', retryingBy("outer"))};`
      ),
      { engine: retryingEngine(wrongCatch) }
    );
    // Its retry's code fails where its policy has nothing to decide.
    const failing = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { throw new Error("again"); })()', ', retry: async () => { throw new Error("no choice"); }')};`
      ),
      { engine: retryingEngine() }
    );
    expect({
      notTransient,
      notTransientDecided: retrySteps(asked, "decide"),
      failing,
      forged,
      forgedRan: retrySteps(wrongCatch, "run"),
    }).toStrictEqual({
      notTransient: failedWith("expression.failed"),
      notTransientDecided: 0,
      // The policy's rounds, its code never asked.
      failing: failedWith("internal.unexpected"),
      forged: failedWith("internal.unexpected"),
      forgedRan: 2,
    });
  });

  it("decides a replay as it decided the run: its retries, its sleep's deadline and its catch, from the engine's journal", async () => {
    const module = moduleOf(`
let rounds = 0;
const fetched = ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()', retryingBy("guarded"))};
${enterPause("Date.now() + 1000")}
${sleepPause("until")}
try {
  try {
    ${taskStep("stop", "{ output: null }")};
  } catch (thrown) {
    if (${catchStep("inner", "async () => true")} === undefined) throw thrown;
  }
} catch (thrown) {
  const caught = ${catchStep("outer", "async () => true")};
  if (caught === undefined) throw thrown;
  return { fetched, caught, rounds };
}`);
    const runId = await waitingRun(sealed);
    const journal = new Map<string, Journaled>();
    const first: string[] = [];
    const ran = await ranAs(runId, module, {
      engine: journalingEngine(journal, first),
    });
    const again: string[] = [];
    const replayed = await ranAs(runId, module, {
      engine: journalingEngine(journal, again),
    });
    const outcome = { fetched: { output: 3 }, caught: stopped };
    expect({
      ran,
      decided: first.filter((name) => name.endsWith(":decide")).length,
      replayed,
      ranAgain: again,
    }).toStrictEqual({
      ran: { ended: { ...outcome, rounds: 3 }, tampered: [] },
      decided: 2,
      // Nothing runs again, and nothing is refused: every step, its
      // deadline and its catch, is the journal's.
      replayed: { ended: { ...outcome, rounds: 0 }, tampered: [] },
      ranAgain: [],
    });
  });

  it("refuses a step started while another runs, past the SDK", async () => {
    const ran = await ranAs(
      await waitingRun(sealed),
      // The engine itself, as code past the SDK has it: no \`workflow\`.
      `export default { run: async (engine) => {
  let release = () => undefined;
  const held = new Promise((resolve) => { release = resolve; });
  const first = engine.do("fetch:task", {}, async () => { await held; return { output: 1 }; });
  try {
    await engine.do("finish:task", {}, async () => ({ output: 2 }));
    return "both";
  } catch (error) {
    return error.code;
  } finally {
    release();
    await first.catch(() => null);
  }
} };`
    );
    expect(ran).toStrictEqual({
      ended: "workflow.invalid",
      tampered: ["workflow.invalid"],
    });
  });

  it("lets only the catch its retry's decision named take the failure, and refuses a step that withholds a decision its policy asks for", async () => {
    // Task `ping` fails; the catch of `probe` around it has a condition,
    // and the one of `layered` around that has none, and retries.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the test it builds for
    const ping = (retry: string): string =>
      taskStep("ping", '(() => { throw new Error("down"); })()', retry);
    // Its inner catch's condition doesn't hold for the error it sees.
    const catches = `
  if ((${catchStep("probe", "async () => false")}) !== undefined) return "probe";
  return (${catchStep("layered", "async () => true")}) === undefined ? "none" : "layered";`;
    const tries = new Map<string, number>();
    // A workflow of its own: its person's runs of one are bounded.
    const layering = await sealedWorkflow();
    const run = async (retry: string, engine = retryingEngine()) =>
      await ranAs(
        await waitingRun(layering),
        moduleOf(`try { ${ping(retry)}; } catch { ${catches} }`),
        { engine }
      );
    const withheld = await run("");
    // It said the inner catch takes it, then that it doesn't: the outer
    // is offered nothing.
    const probeThenLayered = await run(
      ', retry: async () => ({ by: "probe", retry: false })'
    );
    // It declined the outer catch's retry, which has no conditions.
    const declined = await run(
      ', retry: async () => ({ by: "layered", retry: false })'
    );
    // Its policy's last round has no decision: what an earlier round's
    // named holds no more, and its condition decides afresh.
    const lastRound = await ranAs(
      await waitingRun(layering),
      moduleOf(`try { ${ping(', retry: async () => ({ by: "layered", retry: true })')}; } catch {
  return (${catchStep("probe", "async () => true")}) === undefined ? "none" : "probe";
}`),
      { engine: retryingEngine(tries) }
    );
    expect({
      withheld,
      probeThenLayered,
      declined,
      roundsRun: retrySteps(tries, "run"),
      lastRound,
    }).toStrictEqual({
      withheld: refusedAs(
        `Step "ping:task" gives no retry for its policy to ask.`
      ),
      probeThenLayered: {
        ended: "none",
        tampered: [],
        untaken: "internal.unexpected",
      },
      declined: refusedAs(`Task "layered"'s catch retries the failure.`),
      roundsRun: 2,
      lastRound: { ended: "probe", tampered: [] },
    });
  });

  it("sleeps only as long as sealed, or until exactly the deadline its task recorded", async () => {
    // A workflow of its own: its person's runs of one are bounded.
    const sleeping = await sealedWorkflow();
    const run = async (body: string) =>
      await ranAs(await waitingRun(sleeping), moduleOf(body));
    expect({
      sealedLength: await run(
        'await step.sleep("linger", { key: "task", description: "Its wait", duration: "1 hour" }); return "slept";'
      ),
      otherLength: await run(
        'await step.sleep("linger", { key: "task", description: "Its wait", duration: "1 minute" }); return "slept";'
      ),
      recorded: await run(
        `${enterPause("Date.now() + 1000")} ${sleepPause("until")} return "woke";`
      ),
      otherDeadline: await run(
        `${enterPause("Date.now() + 1000")} ${sleepPause("until - 1")} return "woke";`
      ),
      unrecorded: await run(`${sleepPause("Date.now()")} return "woke";`),
      asDo: await run(`return ${taskStep("pause", "{ output: null }")};`),
      notADuration: await ranAs(
        await waitingRun(sleeping),
        `export default { run: async (engine) => { try { await engine.sleep("pause:task", "x"); return "slept"; } catch (error) { return error.code; } } };`
      ),
      tooFar: await run(
        `${enterPause("Date.now() + 2 * 365 * 86400000")} return "entered";`
      ),
    }).toStrictEqual({
      sealedLength: { ended: "slept", tampered: [] },
      otherLength: refusedAs(`Step "linger:task" isn't one the build seals.`),
      recorded: { ended: "woke", tampered: [] },
      otherDeadline: refusedAs(`Step "pause:task" isn't one the build seals.`),
      unrecorded: refusedAs(`Step "pause:task" isn't one the build seals.`),
      asDo: refusedAs(`Step "pause:task" isn't one the build seals.`),
      notADuration: {
        ended: "workflow.invalid",
        tampered: ["workflow.invalid"],
      },
      tooFar: failedWith("workflow.call_invalid"),
    });
  });

  it("holds a test run's sleeps, deadlines and retry backoffs to its wait limit, which no catch takes", async () => {
    const limited = await sealedWorkflow();
    const caughtOrNot = (steps: string): string => `
try {
  ${steps}
} catch (thrown) {
  const error = ${catchStep("guarded", "async () => true")};
  if (error === undefined) throw thrown;
  return { caught: error.status };
}`;
    const run = async (body: string, maxSleepMs: number, engine?: Engine) =>
      await ranAs(await waitingRun(limited), moduleOf(body), {
        maxSleepMs,
        ...(engine === undefined ? {} : { engine }),
      });
    const minute = 60_000;
    expect({
      sleep: await run(
        'await step.sleep("linger", { key: "task", description: "Its wait", duration: "1 hour" }); return "slept";',
        minute
      ),
      farDeadline: await run(
        `${enterPause("Date.now() + 2 * 60000")} ${sleepPause("until")} return "woke";`,
        minute
      ),
      nearDeadline: await run(
        `${enterPause("Date.now() + 1000")} ${sleepPause("until")} return "woke";`,
        minute
      ),
      // Its policy backs off a second, past the half a second it may wait.
      backoff: await run(
        caughtOrNot(
          `return ${taskStep("fetch", '(() => { throw new Error("not yet"); })()', retryingBy("guarded"))};`
        ),
        500,
        retryingEngine()
      ),
      backoffWithin: await run(
        caughtOrNot(
          `let rounds = 0; return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 2) throw new Error("not yet"); return { output: rounds }; })()', retryingBy("guarded"))};`
        ),
        minute,
        retryingEngine()
      ),
    }).toStrictEqual({
      sleep: failedWith("workflow.candidate_wait_limit"),
      farDeadline: failedWith("workflow.candidate_wait_limit"),
      nearDeadline: { ended: "woke", tampered: [] },
      backoff: failedWith("workflow.candidate_wait_limit"),
      backoffWithin: { ended: { output: 2 }, tampered: [] },
    });
  });
});
