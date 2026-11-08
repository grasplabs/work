import { isRecord } from "@grasp-os/shared/json";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { z } from "zod";

import type { EngineDecision, WorkflowEngine } from "./engine.ts";
import {
  generatedStepOptionSchemas,
  namePattern,
  nameRule,
  stepOptionSchemas,
} from "./steps.ts";
import { invalidCall, parseOrThrow } from "./workflow-error.ts";
import {
  caughtErrorSchema,
  caughtJournalSchema,
  eventWaitSchema,
} from "./workflow-steps.ts";
import type { UntypedStepRunner } from "./workflow-steps.ts";

// Core requires exactly this key on the step's connection calls.
const idempotencyKeyOf = (engine: WorkflowEngine, step: string): string =>
  stepIdempotencyKey(engine.runId, step);

/** A step call's options, checked against its method's schema. */
const optionsOf = <Schema extends z.ZodType>(
  schema: Schema,
  name: string,
  options: unknown
): z.output<Schema> =>
  parseOrThrow(
    schema,
    options,
    "workflow.invalid_step_call",
    `Options of step "${name}"`
  );

export const createRunner = (
  engine: WorkflowEngine
): {
  steps: UntypedStepRunner;
} => {
  const started = new Set<string>();
  // The step running now, if any. They run one after another: one started
  // from inside a step's function, or next to another, would be recorded
  // in an order a replay can't promise to repeat.
  let running: string | undefined;

  const exclusive = async <T>(what: string, run: () => Promise<T>) => {
    if (running !== undefined) {
      throw invalidCall(
        `${what} started while ${running} runs; run steps one after another, never inside a step`
      );
    }
    running = what;
    try {
      return await run();
    } finally {
      running = undefined;
    }
  };

  // Returns the step's engine name: its name, or `name:key` for a keyed
  // step. Types catch most bad calls; workflow code that got past them
  // still fails here, before anything runs.
  const start = (name: string, key: string | number | undefined): string => {
    if (typeof name !== "string" || !namePattern.test(name)) {
      throw invalidCall(`Step "${name}" needs a name of ${nameRule}`);
    }
    // Encoded, so a key never contains the separators of engine step names.
    const step =
      key === undefined ? name : `${name}:${encodeURIComponent(key)}`;
    if (started.has(step)) {
      throw invalidCall(
        key === undefined
          ? `Step "${name}" already ran in this run; give each run of it its own key`
          : `Step "${name}" already ran with key "${String(key)}" in this run`
      );
    }
    started.add(step);
    return step;
  };

  const steps: UntypedStepRunner = {
    do: async (name, rawOptions, fn) =>
      await exclusive(`Step "${name}"`, async () => {
        // `retry` is generated code's alone, checked apart from the
        // options the describer reads.
        const retry = optionsOf(
          generatedStepOptionSchemas.retry,
          name,
          isRecord(rawOptions) ? rawOptions.retry : undefined
        );
        const options = optionsOf(
          stepOptionSchemas.do,
          name,
          isRecord(rawOptions)
            ? Object.fromEntries(
                Object.entries(rawOptions).filter(([key]) => key !== "retry")
              )
            : rawOptions
        );
        const step = start(name, options.key);
        if (typeof fn !== "function") {
          throw invalidCall(`Step "${name}" needs a function to run`);
        }
        const { input, retries, timeout } = options;
        const sideEffect = options.sideEffect === true;
        return await engine.do(
          step,
          { retries, timeout, sideEffect, input },
          async () =>
            sideEffect
              ? await fn({
                  idempotencyKey: idempotencyKeyOf(engine, step),
                  input,
                })
              : await fn({ input }),
          retry === undefined
            ? undefined
            : async (error) => await retry(caughtErrorSchema.parse(error))
        );
      }),

    llm: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const options = optionsOf(stepOptionSchemas.llm, name, rawOptions);
        const step = start(name, options.key);
        const { instructions, input, schema, retries, timeout } = options;
        const request = {
          step,
          binding: options.binding,
          instructions,
          input,
          // The model writes what the schema accepts, so describe its input
          // side.
          outputSchema: z.toJSONSchema(schema, { io: "input" }),
        };
        // The raw answer is recorded, not the parsed one: parsed output may
        // hold values that don't survive being recorded (a transform to a
        // Date, say). Checking it inside the step makes an answer that
        // doesn't fit a failure the step's retries may fix.
        const answer = await engine.do(
          step,
          { retries, timeout, input },
          async () => {
            const raw = await engine.callModel(request);
            parseOrThrow(
              schema,
              raw,
              "workflow.invalid_model_output",
              `Answer to step "${name}"`
            );
            return raw;
          }
        );
        return parseOrThrow(
          schema,
          answer,
          "workflow.invalid_model_output",
          `Answer to step "${name}"`
        );
      }),

    decision: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const { key, description, from, ask, timeout, remindAfter } = optionsOf(
          stepOptionSchemas.decision,
          name,
          rawOptions
        );
        const step = start(name, key);

        // The engine sets the deadline when the decision opens, so time
        // spent asking or reminding never pushes it out, and no answer
        // counts after it. Other times are taken inside steps, so a replay
        // computes the same waits.
        const { decision, deadline } = await engine.do(
          step,
          { input: { from } },
          async () =>
            await engine.openDecision({ step, from, description, timeout })
        );
        // Asking is a side effect, which a dry run doesn't run, so when it
        // finished is a step of its own rather than the ask step's result.
        const askPeople = async (reminder: boolean): Promise<number> => {
          const askStep = `${step}#${reminder ? "remind" : "ask"}`;
          await engine.do(
            askStep,
            { sideEffect: true, input: { from, reminder } },
            async () => {
              const recipients = await engine.decisionRecipients(
                decision,
                reminder
              );
              // A reminder of a decision that was answered or has closed
              // (timed out) goes to nobody, so it isn't sent at all.
              if (reminder && recipients.length === 0) {
                return;
              }
              await ask({
                recipients,
                reminder,
                idempotencyKey: idempotencyKeyOf(engine, askStep),
              });
            }
          );
          return await engine.do(
            `${step}#${reminder ? "reminded" : "asked"}`,
            {},
            async () => await Promise.resolve(Date.now())
          );
        };
        const waitForAnswer = async (
          waitStep: string,
          since: number,
          until: number,
          last: boolean
        ): Promise<EngineDecision> =>
          await engine.waitForDecision(waitStep, {
            decision,
            timeout: Math.max(until - since, 0),
            last,
          });

        const askedAt = await askPeople(false);
        const remindAt =
          remindAfter === undefined ? undefined : askedAt + remindAfter;
        const reminds = remindAt !== undefined && remindAt < deadline;
        let answer = await waitForAnswer(
          `${step}#answer`,
          askedAt,
          reminds ? remindAt : deadline,
          !reminds
        );
        if (!answer.answered && reminds) {
          const remindedAt = await askPeople(true);
          answer = await waitForAnswer(
            `${step}#answer-after-reminder`,
            remindedAt,
            deadline,
            true
          );
        }
        if (!answer.answered) {
          return { timedOut: true };
        }
        return {
          timedOut: false,
          approved: answer.approved,
          by: answer.by,
          payload: answer.payload,
        };
      }),

    sleep: async (name, rawOptions) => {
      await exclusive(`Step "${name}"`, async () => {
        const { key, duration } = optionsOf(
          stepOptionSchemas.sleep,
          name,
          rawOptions
        );
        await engine.sleep(start(name, key), duration);
      });
    },

    sleepUntil: async (name, rawOptions) => {
      await exclusive(`Step "${name}"`, async () => {
        const { key, until } = optionsOf(
          generatedStepOptionSchemas.sleepUntil,
          name,
          rawOptions
        );
        if (engine.sleepUntil === undefined) {
          throw invalidCall(
            `Step "${name}" sleeps until a deadline, which only a generated workflow does`
          );
        }
        await engine.sleepUntil(start(name, key), until);
      });
    },

    caught: async (name, rawOptions, takes) =>
      await exclusive(`Step "${name}"`, async () => {
        const { key } = optionsOf(
          generatedStepOptionSchemas.caught,
          name,
          rawOptions
        );
        if (engine.caught === undefined) {
          throw invalidCall(
            `Step "${name}" is a catch, which only a generated workflow runs`
          );
        }
        if (typeof takes !== "function") {
          throw invalidCall(`Step "${name}" needs a function to decide`);
        }
        const journal = caughtJournalSchema.parse(
          await engine.caught(
            start(name, key),
            {},
            async (error) => await takes(caughtErrorSchema.parse(error))
          )
        );
        return journal.caught ? journal.error : undefined;
      }),

    listen: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const { key } = optionsOf(
          generatedStepOptionSchemas.listen,
          name,
          rawOptions
        );
        if (engine.listen === undefined) {
          throw invalidCall(
            `Step "${name}" waits for an event, which only a generated workflow does`
          );
        }
        return eventWaitSchema.parse(await engine.listen(start(name, key)));
      }),
  };

  return { steps };
};
