import {
  maxWorkflowParams,
  sensitiveParamKey,
  workflowParamNamePattern,
} from "@grasp-os/shared/workflows";

import { descriptorOf } from "./sealed-descriptors.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { ValueDefinitionError } from "./value-descriptor.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer } from "./value-types.ts";
import { checkOrThrow, invalidCall, WorkflowError } from "./workflow-error.ts";

/**
 * The runtime's `Object.freeze`, kept as this module loads: a run's main
 * module (core's workflows/sealed-isolate.ts) loads it before any of the App's code,
 * which could otherwise put its own in its place.
 */
const { freeze } = Object;

/** The longest name a workflow's parameter has. */
const maxParamName = 64;

/**
 * Where a connector call's argument is the sensitive parameter `name`:
 * `await env.mail.call("mail.send", { to, token: sensitiveParam("token") })`.
 * The run never sees the value. Its run host puts in the value the run's
 * start froze, and only where the sealed build has that parameter as a
 * connector call's argument. Any other place refuses it, and so does an
 * App's run.
 */
export const sensitiveParam = (
  name: string
): Readonly<Record<typeof sensitiveParamKey, string>> => {
  if (typeof name !== "string" || name === "" || name.length > maxParamName) {
    throw invalidCall(
      `A sensitive parameter needs a name of 1 to ${maxParamName} characters`
    );
  }
  return freeze({ [sensitiveParamKey]: name });
};

// Parameters

/**
 * A tunable value people see and can change without touching the code:
 * its label, and its type as `v` declares it, with the `.default()` it
 * takes until someone sets it: `{ label: "Review invoices above", type:
 * v.money().default({ minorUnits: 500_000, currency: "EUR" }) }`.
 */
export interface Param {
  /** What people see next to the value, e.g. "Review invoices above". */
  readonly label: string;
  readonly type: AnySchema;
}

export type Params = Record<string, Param>;

/** Parameter values as workflow code reads them: `params.threshold`. */
export type ParamValues<P extends Params> = {
  readonly [Name in keyof P]: Infer<P[Name]["type"]>;
};

/** A parameter as the UI shows it. */
export interface ParamMetadata {
  readonly name: string;
  readonly label: string;
  readonly type: ValueDescriptor;
}

export const describeParams = (params: Params): ParamMetadata[] =>
  Object.entries(params).map(([name, definition]) => ({
    name,
    label: definition.label,
    type: definition.type.descriptor,
  }));

/** The longest label a parameter has, as the format holds it. */
const maxLabelLength = 200;

/**
 * Refuses (`workflow.invalid_definition`) more than 64 parameters, or one
 * whose name isn't an identifier (`params.<name>`), whose label isn't 1
 * to 200 characters, or whose type isn't a `v` schema with a default: the
 * code declares only the parameters it reads, never a sensitive one, so
 * each has a value to start with. A definition outside them fails as it
 * loads, so its tests fail and the version is never made current.
 */
export const validateParams = (params: Params): void => {
  // An object's keys are each one name, so none is declared twice.
  const declared = Object.entries(params);
  if (declared.length > maxWorkflowParams) {
    throw new WorkflowError(
      "workflow.invalid_definition",
      `A workflow declares at most ${maxWorkflowParams} parameters`
    );
  }
  for (const [name, { label, type }] of declared) {
    const invalid = (reason: string): never => {
      throw new WorkflowError(
        "workflow.invalid_definition",
        `Parameter "${name.slice(0, 64)}": ${reason}`
      );
    };
    if (!workflowParamNamePattern.test(name)) {
      invalid("its name is a lower-case letter, then letters and digits");
    }
    if (
      typeof label !== "string" ||
      label === "" ||
      label.length > maxLabelLength
    ) {
      invalid(`its label is 1 to ${maxLabelLength} characters`);
    }
    let presence: string | undefined;
    try {
      ({ presence } = descriptorOf(type));
    } catch (error) {
      if (!(error instanceof ValueDefinitionError)) {
        throw error;
      }
    }
    if (presence !== "default") {
      invalid("its type is a `v` schema with a `.default()`");
    }
  }
};

export const resolveParams = (
  params: Params,
  configured: Readonly<Record<string, unknown>>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(params).map(([name, definition]) => [
      name,
      // One that isn't set takes its type's default; one set to a value
      // its type doesn't take fails, rather than falling back to it.
      checkOrThrow(
        definition.type,
        Object.hasOwn(configured, name) ? configured[name] : undefined,
        "workflow.invalid_param",
        `Parameter "${name}"`
      ),
    ])
  );
