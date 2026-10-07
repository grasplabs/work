import type { Json } from "@grasp-os/shared/json";

import { expressionErrors } from "../src/errors.ts";
import {
  compileExpression,
  evaluateExpression,
  stageVariables,
} from "../src/evaluate.ts";
import type { ResultContract, Stage } from "../src/evaluate.ts";

/** What an expression runs on; any stage variable left out is null. */
export interface Values {
  input?: Json;
  variables?: Record<string, Json>;
  loop?: Record<string, Json>;
}

export interface Placement {
  stage?: Stage;
  scope?: readonly string[];
  pointer?: string;
  loopVariables?: readonly string[];
}

/** Any one JSON value. */
export const json: ResultContract = { kind: "json" };

/**
 * Compiles `source` where `placement` puts it (a task definition by
 * default) and evaluates it on `values`: its result, or the code of the
 * expression error it failed with.
 */
export const run = async (
  source: string,
  values: Values = {},
  contract: ResultContract = json,
  placement: Placement = {}
): Promise<{ result: Json } | { error: string }> => {
  const stage = placement.stage ?? "taskDefinition";
  try {
    const expression = await compileExpression(source, {
      stage,
      scope: placement.scope ?? ["task"],
      pointer: placement.pointer ?? "/do/0/task",
      loopVariables: placement.loopVariables ?? Object.keys(values.loop ?? {}),
    });
    const variables: Record<string, Json> = {};
    for (const name of stageVariables[stage]) {
      if (name !== "runtime") {
        variables[name] = values.variables?.[name] ?? null;
      }
    }
    const result = await evaluateExpression(
      expression,
      {
        input: values.input ?? null,
        variables,
        ...(values.loop === undefined ? {} : { loop: values.loop }),
      },
      contract
    );
    return { result };
  } catch (error) {
    const code = expressionErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    return { error: code };
  }
};

/** The code of the expression error compiling `source` fails with. */
export const compileError = async (
  source: string,
  placement: Placement = {}
): Promise<string | undefined> => {
  try {
    await compileExpression(source, {
      stage: placement.stage ?? "taskDefinition",
      scope: placement.scope ?? ["task"],
      pointer: placement.pointer ?? "/do/0/task",
      loopVariables: placement.loopVariables ?? [],
    });
    return undefined;
  } catch (error) {
    const code = expressionErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    return code;
  }
};
