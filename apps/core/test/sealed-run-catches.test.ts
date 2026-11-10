import { expectedMessageOf } from "@grasp-os/shared/errors";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowDuration } from "@grasp-os/workerflow/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { connectModels } from "./model-provider.ts";
import { admittedFreely } from "./runs.ts";
import {
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
  waitingRun,
  allowedModel,
} from "./sealed-run-harness.ts";
import type { Engine, Journaled, Sealed, Tries } from "./sealed-run-harness.ts";
import { failingStep, taskStep } from "./sealed-runs.ts";

/** `levels` lists around a text, as a module's expression. */
const nestedIn = (levels: number): string =>
  `Array.from({ length: ${levels} }).reduce((inner) => [inner], "x")`;

/** `pause`'s enter step, recording the deadline `until`, as `until`. */
const enterPause = (until: string): string =>
  `const { until } = await step.do("pause", { key: "enter", description: "Its start" }, async () => ({ output: null, until: ${until} }));`;

/** `pause`'s sleep, until `until`. */
const sleepPause = (until: string): string =>
  `await step.sleepUntil("pause", { key: "task", description: "Its sleep", until: ${until} });`;

/** A call's retry choice, as generated code passes it: whether its `when` holds. */
const retryWhen = (holds: boolean): string =>
  `, retry: async () => ${String(holds)}`;

/** `steps`, its code returning the code of what it catches of them. */
const caughtOrNot = (steps: string): string => `
try {
  ${steps}
} catch (thrown) {
  return { caught: thrown.code };
}`;

/** Step `finish`, a sleep of a second. */
const finishSleep =
  'await step.sleep("finish", { key: "task", description: "Its sleep", duration: 1000 })';

/** The engine's steps, by key, that a retry of `fetch` ran of `part`. */
const retrySteps = (tries: Tries, part: "decide" | "run"): number =>
  [...tries.keys()].filter(
    (key) =>
      key.startsWith("key:$grasp:wait:") &&
      key.includes(`:retry:`) &&
      key.endsWith(`:${part}`)
  ).length;

// The ways a catch, a raise, a retry or a sleep can fail a sealed run's
// security, each refused or held by the host: code going on past a
// failure no try around its step may take; code relabelling the host's
// failure of its call; a raise its build doesn't seal ending a run; a
// retry past its policy's rounds, or by a try whose code the failure
// hasn't; a sleep of another length, or until another deadline than the
// one recorded; an attempt longer than its policy lets.
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

  it("fails a run with a raise only as its build seals it, whatever its code says", async () => {
    const run = async (body: string) =>
      await ranAs(await waitingRun(sealed), moduleOf(body));
    expect({
      sealedCode: await run(
        'throw new AppError("test.stop", "In the code\'s own words.");'
      ),
      unsealedCode: await run(
        'throw new AppError("test.other", "Not a raise of the build.");'
      ),
      // Its own catch takes it in its code: no step failed.
      caughtInCode: await run(
        'try { throw new AppError("test.stop", "Stopped."); } catch (thrown) { return thrown.code; }'
      ),
      // A raise has no step of its own.
      asStep: await run(`return ${taskStep("stop", "{ output: null }")};`),
      // What the isolate claims of its own failure, a platform's code, a
      // timeout or a code of no shape, its words quoting what it read.
      platformCode: await run(
        'throw Object.assign(new Error("The secret is 42."), { code: "connect.forbidden" });'
      ),
      timedOut: await run(
        'const error = new Error("The secret is 42."); error.name = "TimeoutError"; throw error;'
      ),
      noCode: await run(
        'throw Object.assign(new Error("The secret is 42."), { code: "x" });'
      ),
    }).toStrictEqual({
      sealedCode: { ended: "test.stop", why: "Stopped.", tampered: [] },
      unsealedCode: {
        ended: undefined,
        why: "The task failed.",
        tampered: [],
      },
      caughtInCode: { ended: "test.stop", tampered: [] },
      asStep: refusedAs(`Step "stop:task" isn't one the build seals.`),
      platformCode: { ended: undefined, why: "The task failed.", tampered: [] },
      timedOut: {
        ended: "expression.failed",
        why: expectedMessageOf("expression.failed"),
        tampered: [],
      },
      noCode: { ended: undefined, why: "The task failed.", tampered: [] },
    });
  });

  it("lets its code go on past a failure only where a try around the failed step may take it", async () => {
    const run = async (body: string) =>
      await ranAs(await waitingRun(sealed), moduleOf(body));
    expect({
      // `send` is in no try.
      noTry: await run(
        `try { ${failingStep("send")}; } catch {} ${finishSleep}; return "on";`
      ),
      noTryEnded: await run(
        `try { ${failingStep("send")}; } catch {} return "done";`
      ),
      // `fetch`'s try takes any failure.
      takenByTry: await run(
        `try { ${failingStep("fetch")}; } catch {} ${finishSleep}; return "on";`
      ),
      // `ping`'s tries take only `internal.unexpected`: not this one.
      otherCode: await run(
        `try { ${failingStep("ping")}; } catch {} ${finishSleep}; return "on";`
      ),
      ofItsCode: await run(
        `try { ${failingStep("ping", retryWhen(false), false)}; } catch {} ${finishSleep}; return "on";`
      ),
      asCatchStep: await run(
        `return await step.do("guarded", { key: "catch", description: "Its catch" }, async () => true);`
      ),
    }).toStrictEqual({
      noTry: refusedAs(
        "A run goes on past a failure only where a catch around its step takes it."
      ),
      noTryEnded: {
        ended: "done",
        tampered: [],
        untaken: "workflow.task_data_invalid",
      },
      takenByTry: { ended: "on", tampered: [] },
      otherCode: refusedAs(
        "A run goes on past a failure only where a catch around its step takes it."
      ),
      ofItsCode: { ended: "on", tampered: [] },
      asCatchStep: refusedAs(`Step "guarded:catch" isn't one the build seals.`),
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
  return ${taskStep("fetch", '(async () => { try { await env.mail.call("mail.send", { to: input.who, subject: "x" }); } catch {} return { output: "sent" }; })()', retryWhen(false))};
} catch (thrown) {
  return { code: thrown.code };
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
  ${taskStep("fetch", '(async () => { await env.mail.call("mail.send", { to: input.who, subject: "x" }); throw new Error("after"); })()', retryWhen(false))};
} catch (thrown) {
  return { code: thrown.code };
}`)
    );
    // Its call took effect, then its lineage had no host call left for a
    // next one: it failed after its effect all the same.
    let hostCalls = 0;
    const spentAfter = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(async () => { await env.mail.call("mail.send", { to: input.who, subject: "x" }); await env.mail.call("mail.send", { to: input.who, subject: "x" }).catch(() => null); return { output: "sent" }; })()', retryWhen(false))};
} catch (thrown) {
  return { code: thrown.code };
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
  ${taskStep("fetch", '(() => { const error = new Error("Execution timed out, CPU time limit"); error.code = "connect.outcome_unknown"; throw error; })()', retryWhen(false))};
} catch (thrown) {
  return { code: thrown.code ?? null, message: thrown.message };
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
        ended: { code: "workflow.call_denied" },
        tampered: [],
      },
      rejected: {
        ended: { code: "workflow.call_denied" },
        tampered: [],
        untaken: "workflow.call_denied",
      },
      afterEffect: {
        ended: { code: "workflow.failed_after_effect" },
        tampered: [],
        untaken: "workflow.failed_after_effect",
      },
      spentAfter: {
        ended: { code: "workflow.failed_after_effect" },
        tampered: [],
        untaken: "workflow.failed_after_effect",
      },
      // Its code's own failure, in the platform's words, never its own.
      relabelled: {
        ended: {
          code: "internal.unexpected",
          message: "Something went wrong.",
        },
        tampered: [],
      },
    });
  });

  it("fails a call its run's data nests past 34 levels as its step's own failure, which a catch takes, and refuses a forged deep literal or slot", async () => {
    // Its `rows` slot is three levels into the arguments, so an
    // evaluation's result there, at most 32 deep, may nest them 35 levels
    // deep; its `who` slot is two levels in.
    const whoInput = { $expr: "args.who" };
    const deep = await sealedWorkflow([
      {
        id: "careful",
        type: "try",
        try: [
          {
            id: "ask",
            type: "generate",
            instructions: "Sum up.",
            input: { who: whoInput, rows: [whoInput] },
            returns: objectOf({ line: { kind: "string" } }),
          },
        ],
        catch: { code: "workflow.arguments_too_deep" },
      },
    ]);
    /** `ask`'s step, sending `instructions`, `who` and a row `levels` deep. */
    const ask = ({
      instructions = '"Sum up."',
      who = "args.who",
      levels = 1,
    }: {
      instructions?: string;
      who?: string;
      levels?: number;
    }) =>
      taskStep(
        "ask",
        `(async () => ({ output: await env.ai.call("grasp.model", { instructions: ${instructions}, input: { who: ${who}, rows: [${nestedIn(levels)}] } }) }))()`
      );
    const tooDeepRun = await waitingRun(deep);
    const tooDeep = await ranAs(
      tooDeepRun,
      moduleOf(`
try {
  return ${ask({ levels: valueDepth })};
} catch (thrown) {
  return { code: thrown.code, message: thrown.message };
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
          message:
            "This step's arguments are nested deeper than 34 levels, so its call wasn't made.",
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
return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()', retryWhen(true))};`),
      { engine: retryingEngine(tries, timeouts) }
    );
    const thirdSteps = {
      decided: retrySteps(tries, "decide"),
      ran: retrySteps(tries, "run"),
      timeout: timeouts.get("key:fetch:task"),
    };
    // Its call gives no retry for its policy to ask: generated code
    // always does, so this is code past the generator.
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
        `return ${taskStep("fetch", '(() => { throw new Error("never"); })()', retryWhen(true))};`
      ),
      { engine: retryingEngine(always) }
    );
    expect({
      third,
      withheld: withheld.tampered,
      thirdSteps,
      never,
      neverRan: retrySteps(always, "run"),
    }).toStrictEqual({
      third: { ended: { output: 3 }, tampered: [] },
      withheld: ["workflow.invalid"],
      thirdSteps: { decided: 2, ran: 2, timeout: 20_000 },
      // Its policy's three rounds, then the failure goes on.
      never: failedWith("internal.unexpected"),
      neverRan: 2,
    });
  });

  it("retries nothing a retry may not fix, nor by a try whose code the failure hasn't, nor once its `when` doesn't hold", async () => {
    const asked = new Map<string, number>();
    const notTransient = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { const error = new Error("bad"); error.code = "expression.failed"; throw error; })()', retryWhen(true))};`
      ),
      { engine: retryingEngine(asked) }
    );
    // `ping`'s retrying try takes only `internal.unexpected`.
    const otherCode = new Map<string, number>();
    const notItsCode = await ranAs(
      await waitingRun(sealed),
      moduleOf(`return ${failingStep("ping", retryWhen(true))};`),
      { engine: retryingEngine(otherCode) }
    );
    const declining = new Map<string, number>();
    const declined = await ranAs(
      await waitingRun(sealed),
      moduleOf(`return ${failingStep("fetch", retryWhen(false), false)};`),
      { engine: retryingEngine(declining) }
    );
    // Its retry's code fails: no retry.
    const failing = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${failingStep("fetch", ', retry: async () => { throw new Error("no choice"); }', false)};`
      ),
      { engine: retryingEngine() }
    );
    // A choice that isn't a boolean is no choice its code makes.
    const forged = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${failingStep("fetch", ', retry: async () => ({ by: "guarded", retry: true })', false)};`
      ),
      { engine: retryingEngine() }
    );
    expect({
      notTransient,
      notTransientDecided: retrySteps(asked, "decide"),
      notItsCode,
      notItsCodeDecided: retrySteps(otherCode, "decide"),
      declined,
      declinedRan: retrySteps(declining, "run"),
      failing,
      forged: forged.tampered,
    }).toStrictEqual({
      notTransient: failedWith("expression.failed"),
      notTransientDecided: 0,
      notItsCode: failedWith("workflow.task_data_invalid"),
      notItsCodeDecided: 0,
      declined: failedWith("internal.unexpected"),
      declinedRan: 0,
      failing: failedWith("internal.unexpected"),
      forged: ["workflow.invalid"],
    });
  });

  it("decides a replay as it decided the run: its retries and its sleep's deadline, from the engine's journal", async () => {
    const module = moduleOf(`
let rounds = 0;
const fetched = ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()', retryWhen(true))};
${enterPause("Date.now() + 1000")}
${sleepPause("until")}
try {
  throw new AppError("test.stop", "Stopped.");
} catch (thrown) {
  return { fetched, caught: thrown.code, rounds };
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
    const outcome = { fetched: { output: 3 }, caught: "test.stop" };
    expect({
      ran,
      decided: first.filter((name) => name.endsWith(":decide")).length,
      replayed,
      ranAgain: again,
    }).toStrictEqual({
      ran: { ended: { ...outcome, rounds: 3 }, tampered: [] },
      decided: 2,
      // Nothing runs again, and nothing is refused: every step, and its
      // deadline, is the journal's.
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

  it("retries a failure by the try around its call whose code it has, as its code says its `when` holds, and refuses a call that withholds the choice", async () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the test it builds for
    const ping = (retry: string): string => failingStep("ping", retry, false);
    // A workflow of its own: its person's runs of one are bounded.
    const layering = await sealedWorkflow();
    const run = async (retry: string, engine = retryingEngine()) =>
      await ranAs(
        await waitingRun(layering),
        moduleOf(
          `try { ${ping(retry)}; } catch (thrown) { return thrown.code; }`
        ),
        { engine }
      );
    const withheld = await run("");
    const holding = new Map<string, number>();
    const holds = await run(retryWhen(true), retryingEngine(holding));
    const notHolding = new Map<string, number>();
    const doesNotHold = await run(retryWhen(false), retryingEngine(notHolding));
    expect({
      withheld: withheld.tampered,
      holds,
      holdsRan: retrySteps(holding, "run"),
      doesNotHold,
      doesNotHoldRan: retrySteps(notHolding, "run"),
    }).toStrictEqual({
      withheld: ["workflow.invalid"],
      holds: { ended: "internal.unexpected", tampered: [] },
      holdsRan: 2,
      doesNotHold: { ended: "internal.unexpected", tampered: [] },
      doesNotHoldRan: 0,
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
          `return ${taskStep("fetch", '(() => { throw new Error("not yet"); })()', retryWhen(true))};`
        ),
        500,
        retryingEngine()
      ),
      backoffWithin: await run(
        caughtOrNot(
          `let rounds = 0; return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 2) throw new Error("not yet"); return { output: rounds }; })()', retryWhen(true))};`
        ),
        minute,
        retryingEngine()
      ),
    }).toStrictEqual({
      sleep: failedWith("workflow.candidate_wait_limit"),
      farDeadline: failedWith("workflow.candidate_wait_limit"),
      nearDeadline: { ended: "woke", tampered: [] },
      // Its code takes it in its catch, but no catch may: the run fails
      // with it as it ends.
      backoff: {
        ended: { caught: "workflow.candidate_wait_limit" },
        tampered: [],
        untaken: "workflow.candidate_wait_limit",
      },
      backoffWithin: { ended: { output: 2 }, tampered: [] },
    });
  });
});
