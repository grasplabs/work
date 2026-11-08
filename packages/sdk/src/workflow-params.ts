import {
  paramDeclarationSchema,
  paramDeclarationsSchema,
  sensitiveParamKey,
} from "@grasp-os/shared/workflows";

import { currencySchema, paramValueSchemas } from "./params.ts";
import type { ParamDefault, ParamKind, ParamValue } from "./params.ts";
import { invalidCall, parseOrThrow } from "./workflow-error.ts";

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

export type Person = ParamValue<"person">;
export type Schedule = ParamValue<"schedule">;
export type Template = ParamValue<"template">;

/** A tunable value people see and can change without touching the code. */
export interface Param<Kind extends ParamKind = ParamKind> {
  kind: Kind;
  /** What people see next to the value, e.g. "Review invoices above". */
  label: string;
  default: ParamDefault<Kind>;
  /**
   * Its value needs care where it's shown. People set it like any other,
   * and no value ever goes in the audit log.
   */
  sensitive: boolean;
  /** For money: the ISO 4217 currency its amounts are in, e.g. `EUR`. */
  currency?: string;
}

interface ParamOptions<Kind extends ParamKind> {
  label: string;
  default: ParamDefault<Kind>;
  /** Its value needs care where it's shown; defaults to false. */
  sensitive?: boolean;
}

const param =
  <Kind extends ParamKind>(kind: Kind) =>
  (options: ParamOptions<Kind>): Param<Kind> => ({
    kind,
    label: options.label,
    default: options.default,
    sensitive: options.sensitive ?? false,
  });

/**
 * An amount of money in whole minor units of `currency` (cents for EUR):
 * `default: 500_000` is €5,000.00.
 */
export const money = (
  options: ParamOptions<"money"> & {
    /** ISO 4217, e.g. `EUR`. */
    currency: string;
  }
): Param<"money"> => ({
  ...param("money")(options),
  currency: options.currency,
});
/** A number. */
export const number = param("number");
/** A piece of text. */
export const text = param("text");
/** A person or group, e.g. who reviews; required by `step.decision`. */
export const person = param("person");
/** A schedule, as five cron fields. */
export const schedule = param("schedule");
/** A template, e.g. for an email. */
export const template = param("template");

export type Params = Record<string, Param>;

/** Parameter values as workflow code reads them: `params.threshold`. */
export type ParamValues<P extends Params> = {
  readonly [Name in keyof P]: ParamValue<P[Name]["kind"]>;
};

/** A parameter as the UI shows it. */
export interface ParamMetadata {
  name: string;
  kind: ParamKind;
  label: string;
  default: string | number;
  sensitive: boolean;
  /** For money: its ISO 4217 currency; amounts are in its minor units. */
  currency?: string;
}

export const describeParams = (params: Params): ParamMetadata[] =>
  Object.entries(params).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    label: definition.label,
    default: definition.default,
    sensitive: definition.sensitive,
    ...(definition.currency === undefined
      ? {}
      : { currency: definition.currency }),
  }));

export const validateParams = (params: Params): void => {
  // Within the bounds core keeps (`paramDeclarationsSchema`): a definition
  // outside them fails here, so its tests fail and the version is never
  // made current, rather than every run of it failing to load.
  parseOrThrow(
    paramDeclarationsSchema(paramDeclarationSchema),
    describeParams(params),
    "workflow.invalid_definition",
    "Parameters"
  );
  for (const [name, definition] of Object.entries(params)) {
    parseOrThrow(
      paramValueSchemas[definition.kind],
      definition.default,
      "workflow.invalid_definition",
      `Default of parameter "${name}"`
    );
    if (definition.kind === "money") {
      parseOrThrow(
        currencySchema,
        definition.currency,
        "workflow.invalid_definition",
        `Currency of parameter "${name}"`
      );
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
      parseOrThrow(
        paramValueSchemas[definition.kind],
        // A value that is set but empty fails, rather than quietly falling
        // back to the default.
        Object.hasOwn(configured, name) ? configured[name] : definition.default,
        "workflow.invalid_param",
        `Parameter "${name}"`
      ),
    ])
  );
