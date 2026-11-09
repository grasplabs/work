import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { failureOf } from "../src/page-workflows.ts";
import { createIdp } from "./fake-idp.ts";
import {
  definitionOf,
  jsonWorkflowAppsOf,
  keyOf,
  objectSchema,
  passing,
} from "./json-workflow-apps.ts";

// What page-typed-workflows*.test.ts share: the IdP, the App whose page
// starts the typed workflow, and how they read its runs. Each file has the
// IdP answer for its own tests (`mockIdpWith`).

export const idp = createIdp();

export const { signedIn, boundApp } = jsonWorkflowAppsOf(idp);

/** A start of `workflow`, as whatever reference a page sends. */
export const rawStart = (workflow: unknown, input?: unknown): string =>
  JSON.stringify({
    workflow,
    command: "start",
    input: input ?? { who: "Ada" },
    idempotencyKey: keyOf(),
  });

/**
 * A definition whose expression fails on its input, in words that quote
 * what it read: a text this short has no ten-thousandth letter.
 */
export const failingOf = (): string =>
  definitionOf([], {
    status: { $expr: 'input.who.split("")[9999].toUpperCase()' },
  });

/**
 * A definition answering more than the App declares: its status, and a
 * field the App's output doesn't have.
 */
export const widerOf = (): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { kind: "string" } }),
    output: {
      schema: objectSchema({
        status: { kind: "string" },
        secret: { kind: "string" },
      }),
      value: { status: "hello", secret: "ultramarine" },
    },
    steps: [],
  });

/**
 * Core's database for `runEnv`, `before` run once, just before the first
 * read of a workflow's policy generation is sent: a grant or revocation
 * landing while a snapshot is being read.
 */
export const racingGeneration = (before: () => Promise<void>): Env => {
  let pending: Promise<void> | undefined;
  const raced = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "bind") {
          return (...args: unknown[]) => {
            const bound: unknown = Reflect.apply(value, target, args);
            // SAFETY: a prepared statement's bind answers a prepared statement.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            return raced(bound as D1PreparedStatement);
          };
        }
        return async (...args: unknown[]): Promise<unknown> => {
          pending ??= before();
          await pending;
          const answer: unknown = await Reflect.apply(value, target, args);
          return answer;
        };
      },
    });
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare" && typeof value === "function") {
          return (query: string) => {
            const statement: unknown = Reflect.apply(value, target, [query]);
            // SAFETY: prepare answers a prepared statement.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            const prepared = statement as D1PreparedStatement;
            return pending === undefined &&
              query.includes('"policy_generation"') &&
              query.includes('from "workflow_resources"')
              ? raced(prepared)
              : prepared;
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    }),
  };
};

/** A workflow that sleeps a moment, then an hour, then greets. */
export const twoSleepsOf = (): string =>
  definitionOf([
    { id: "first", type: "wait", for: "1 second" },
    { id: "second", type: "wait", for: "1 hour" },
    passing("greet"),
  ]);

/**
 * A workflow asking `recipient` for decision `contract`, as `approval`, in
 * its step `ask`, then greeting.
 */
export const askingOf = (contract: string, recipient: string): string =>
  definitionOf(
    [
      {
        id: "ask",
        type: "decision",
        binding: "approval",
        recipients: [recipient],
        prompt: "Greet them?",
        input: { who: { $expr: "input.who" } },
      },
      passing("greet"),
    ],
    { bindings: { approval: { kind: "decision", contract } } }
  );

/** What a failed run's snapshot says of `error`: its code and words. */
export const failureShown = (error: {
  code: string | null;
  message: string;
}) => {
  const { code, message } = failureOf(error);
  return { code, message };
};

/** The status a push shows, or its refusal's code. */
export const shownOf = (pushed: unknown): unknown =>
  typeof pushed === "string"
    ? pushed
    : z.object({ status: z.string() }).safeParse(pushed).data?.status;

/** The waits a snapshot lists: kind, ID, key, task and `canRespond`. */
export const waitsListed = (snapshot: unknown) =>
  z
    .object({
      waits: z.array(
        z.object({
          kind: z.string(),
          id: z.string(),
          key: z.string(),
          taskId: z.string(),
          canRespond: z.boolean().optional(),
        })
      ),
    })
    .parse(snapshot).waits;

/** How many waits a pushed snapshot lists. */
export const waitsShown = (pushed: unknown): number | undefined =>
  z.object({ waits: z.array(z.unknown()) }).safeParse(pushed).data?.waits
    .length;

/** The code `work` was refused with, or "ok". */
export const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, "code") : error;
    return code;
  }
};
