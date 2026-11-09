import { describe, expect, it } from "vite-plus/test";

import { checkWorkflow } from "../src/check.ts";
import { workflowSchemaUrl } from "../src/format.ts";
import {
  decision,
  eventWait,
  everyCall,
  everyOperator,
  everyStep,
  followedBy,
  keeping,
  problemsOf,
  withDecisions,
  withEventWaits,
  withLoops,
} from "./fixtures.ts";

// Checking grasp-workflow/2: its JSON Schema through the standard
// validator, then only what a schema can't say. Each way a document can be
// wrong, refused with where it is.

/** The codes of `document`'s problems by their pointers, or "ok". */
const codesAt = (document: unknown): unknown => {
  const result = checkWorkflow(document);
  return result.ok
    ? "ok"
    : Object.fromEntries(
        result.problems.map(({ pointer, code }) => [pointer, code])
      );
};

/** The codes of `document`'s problems, or "ok". */
const codesOf = (document: unknown): unknown => {
  const result = checkWorkflow(document);
  return result.ok ? "ok" : result.problems.map(({ code }) => code);
};

/** A connection call passing `subject`, as step `id`. */
const mailing = (id: string, subject: unknown) => ({
  id,
  type: "call",
  connection: "mail",
  action: "mail.send",
  args: { to: "ada@example.com", subject },
});

/** `everyStep` followed by a call whose subject is expression `source`. */
const reading = (source: string) =>
  followedBy(mailing("probe", { $expr: source }));

describe("checking a workflow", () => {
  it("accepts every step kind of the format, and every call", () => {
    expect(
      [
        everyStep(),
        everyCall(),
        everyOperator(),
        withDecisions(decision()),
        withEventWaits(eventWait()),
        withLoops(),
        followedBy(keeping()),
      ].map((document) => codesOf(document))
    ).toStrictEqual(Array.from({ length: 7 }, () => "ok"));
  });

  it("refuses a document of another format, and v1's words", () => {
    expect(
      codesAt({
        $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
        steps: [],
      })
    ).toStrictEqual({ "/$schema": "workflow.version" });
    expect(
      codesAt({
        $schema: workflowSchemaUrl,
        input: { kind: "object", fields: {} },
        bindings: {},
        steps: [],
      })
    ).toStrictEqual({
      "/input": "workflow.unknown_property",
      "/bindings": "workflow.unknown_property",
    });
    expect(
      codesOf(
        followedBy({
          id: "old",
          type: "do",
          binding: "mail",
          operation: "mail.send",
        })
      )
    ).toStrictEqual(["workflow.unknown_step_type"]);
  });

  it("takes what a run returns and its result together, or neither", () => {
    const { result: _result, ...noResult } = everyStep();
    const { returns: _returns, ...noReturns } = everyStep();
    expect(codesOf(noResult)).not.toBe("ok");
    expect(codesOf(noReturns)).not.toBe("ok");
    const { result: _r, returns: _s, ...neither } = everyStep();
    expect(codesOf(neither)).toBe("ok");
  });

  it("refuses two steps of one ID, and a permission of another kind or none", () => {
    expect(codesAt(followedBy(mailing("send", "again")))).toStrictEqual({
      "/steps/5/id": "workflow.duplicate_id",
    });
    expect(
      codesAt(
        followedBy({
          id: "nowhere",
          type: "call",
          connection: "nobody",
          action: "mail.send",
        })
      )
    ).toStrictEqual({ "/steps/5/connection": "workflow.unknown_permission" });
    expect(
      codesAt(
        withDecisions({
          id: "wrong",
          type: "call",
          connection: "approvers",
          action: "mail.send",
        })
      )
    ).toStrictEqual({ "/steps/5/connection": "workflow.permission_kind" });
    const { ai: _ai, ...noModel } = everyStep().permissions;
    expect(codesAt({ ...everyStep(), permissions: noModel })).toStrictEqual({
      "/steps/2": "workflow.unknown_permission",
    });
  });

  it("holds a call to a connection's action or a module, never both or neither", () => {
    expect(
      codesOf(
        followedBy({
          id: "both",
          type: "call",
          connection: "mail",
          action: "mail.send",
          module: "mail",
        })
      )
    ).toStrictEqual(["workflow.call_kind"]);
    expect(codesOf(followedBy({ id: "neither", type: "call" }))).toStrictEqual([
      "workflow.call_kind",
    ]);
  });

  it("refuses one alias under two kinds, and `ai` for anything but the model", () => {
    const document = everyStep();
    expect(
      codesAt({
        ...document,
        permissions: {
          ...document.permissions,
          decisions: { mail: { contract: "grasp.approvals@1" } },
          events: { ai: { contract: "grasp.replies@1" } },
        },
      })
    ).toMatchObject({
      "/permissions/decisions/mail": "workflow.duplicate_alias",
      "/permissions/events/ai": "workflow.duplicate_alias",
    });
  });

  it("names a step by an identifier that shadows nothing the code binds", () => {
    const reserved = [
      "args",
      "params",
      "run",
      "state",
      "inbox",
      "error",
      "item",
      "output",
      "ctx",
      "thrown",
      "caughtError",
      "itemsOf",
      "sensitiveParam",
      "constructor",
      "prototype",
      "delete",
      "new",
      "await",
      "undefined",
      "eval",
    ];
    const invalid = ["send-invoice", "Send", "_send", "__proto__", "a.b"];
    const codeOf = (id: string): unknown =>
      codesAt(followedBy(mailing(id, "x")));
    expect({
      reserved: reserved.map((id) => codeOf(id)),
      invalid: invalid.map((id) => codeOf(id)),
      fine: codeOf("sendInvoice2"),
    }).toStrictEqual({
      reserved: reserved.map(() => ({ "/steps/5/id": "workflow.reserved_id" })),
      invalid: invalid.map(() => ({ "/steps/5/id": "workflow.invalid_id" })),
      fine: "ok",
    });
  });

  it("lets an expression read only the results of steps that ran before it, by their IDs", () => {
    // A later step, a step in an earlier step's list, and its own.
    const { result: _result, returns: _returns, ...open } = everyStep();
    const later = codesAt({
      ...open,
      steps: [mailing("first", { $expr: "second.id" }), mailing("second", "x")],
    });
    const at = "/steps/5/args/subject/$expr";
    expect({
      later,
      nested: codesAt(reading("fetch.id")),
      // Steps that have no result.
      noResult: codesAt(reading("linger.id")),
      flow: codesAt(reading("known")),
      // The v1 forms no longer read anything.
      steps: codesAt(reading("steps.send.output.id")),
      input: codesAt(reading("input.who")),
      fine: codesOf(reading("send.id + greet.line")),
    }).toStrictEqual({
      later: { "/steps/0/args/subject/$expr": "workflow.unreadable" },
      nested: { [at]: "workflow.unreadable" },
      noResult: { [at]: "workflow.unreadable" },
      flow: { [at]: "workflow.unreadable" },
      steps: { [at]: "expression.global" },
      input: { [at]: "expression.global" },
      fine: "ok",
    });
  });

  it("lets `error` be read only in a catch, and `item` only in a loop", () => {
    expect(codesAt(reading("error.code"))).toStrictEqual({
      "/steps/5/args/subject/$expr": "expression.global",
    });
    expect(codesAt(reading("item.name"))).toStrictEqual({
      "/steps/5/args/subject/$expr": "expression.global",
    });
  });

  it("keeps a sensitive parameter to a connection call's args, whole", () => {
    expect(codesOf(reading("params.greeting"))).toBe("ok");
    expect(codesAt(reading('params.token + "!"'))).toStrictEqual({
      "/steps/5/args/subject/$expr": "workflow.unreadable",
    });
    expect(
      codesAt(
        followedBy({
          id: "told",
          type: "generate",
          instructions: { $expr: "params.token" },
          input: {},
          returns: { kind: "string" },
        })
      )
    ).toStrictEqual({ "/steps/5/instructions/$expr": "workflow.sensitive" });
  });

  it("lets `inbox.<alias>` read only a declared event permission's reply address", () => {
    expect(codesAt(reading("inbox.mail"))).toStrictEqual({
      "/steps/5/args/subject/$expr": "workflow.unreadable",
    });
    expect(
      codesOf(withEventWaits(mailing("asked", { $expr: "inbox.replies" })))
    ).toBe("ok");
  });

  it("holds a decision to its permission, and an event wait to its permission and a timeout", () => {
    expect(
      codesAt(withDecisions(decision({ decision: "mail" })))
    ).toStrictEqual({ "/steps/5/decision": "workflow.permission_kind" });
    expect(
      codesAt(withEventWaits(eventWait({ events: "mail" })))
    ).toStrictEqual({ "/steps/5/events": "workflow.permission_kind" });
    const { timeout: _timeout, ...endless } = eventWait();
    expect(codesAt(withEventWaits(endless))).toStrictEqual({
      "/steps/5": "workflow.missing_property",
    });
    expect(
      codesAt(withEventWaits(eventWait({ eventType: " padded" })))
    ).toStrictEqual({ "/steps/5/eventType": "workflow.invalid_event_type" });
    expect(
      codesOf(
        withEventWaits(
          eventWait({
            match: { field: "/invoice", equals: { $expr: "send.id" } },
          })
        )
      )
    ).toBe("ok");
  });

  it("keeps state only from a call or generate step's own result, of declared keys", () => {
    expect(codesOf(followedBy(keeping()))).toBe("ok");
    expect(
      codesAt(followedBy(keeping({ state: { unknown: true } })))
    ).toStrictEqual({
      "/steps/5/state/unknown": "workflow.undeclared_state_key",
    });
    expect(
      codesAt(followedBy(keeping({ state: { runs: "many" } })))
    ).toStrictEqual({ "/steps/5/state/runs": "workflow.state_type" });
    expect(
      codesAt(followedBy({ id: "nap", type: "wait", for: "1 hour", state: {} }))
    ).toStrictEqual({ "/steps/5/state": "workflow.state_not_allowed" });
  });

  it("allows one retrying try around a step, never one inside another", () => {
    const retry = { attempts: 2, delay: "1 minute", backoff: "constant" };
    expect(
      codesAt(
        followedBy({
          id: "outer",
          type: "try",
          try: [
            {
              id: "inner",
              type: "try",
              try: [mailing("deep", "x")],
              catch: { retry },
            },
          ],
          catch: { retry },
        })
      )
    ).toStrictEqual({ "/steps/5/try/0/catch/retry": "workflow.retry_nested" });
  });

  it("refuses a raise passing its error off as the platform's", () => {
    for (const code of [
      "connect.unavailable",
      "workflow.failed",
      "permission.denied",
    ]) {
      expect(
        codesAt(
          followedBy({
            id: "fake",
            type: "raise",
            error: { code, message: "No." },
          })
        )
      ).toStrictEqual({
        "/steps/5/error/code": "workflow.reserved_error_code",
      });
    }
    expect(
      codesAt(
        followedBy({
          id: "malformed",
          type: "raise",
          error: { code: "Not A Code", message: "No." },
        })
      )
    ).toStrictEqual({ "/steps/5/error/code": "workflow.invalid_name" });
  });

  it("refuses a duration longer than a year", () => {
    expect(
      codesAt(followedBy({ id: "forever", type: "wait", for: "53 weeks" }))
    ).toStrictEqual({ "/steps/5/for": "workflow.duration_too_long" });
  });

  it("answers what a caller relies on: args, returns and each parameter", () => {
    const result = checkWorkflow(everyStep());
    if (!result.ok) {
      throw new Error("everyStep is valid");
    }
    expect(result.workflow.contract.args).toMatchObject({ kind: "object" });
    expect(result.workflow.contract.returns).toMatchObject({ kind: "object" });
    expect([...result.workflow.contract.params.keys()]).toStrictEqual([
      "greeting",
      "token",
    ]);
    const { result: _r, returns: _s, args: _a, ...bare } = everyStep();
    const plain = checkWorkflow({ ...bare, steps: [] });
    expect(plain.ok && plain.workflow.contract.returns).toMatchObject({
      kind: "null",
    });
  });
});

describe("expressions reaching past the run's data", () => {
  // The threat model's first layer (`@grasp-os/sdk/expression-check`):
  // whatever the document says, no expression reaches a prototype, a
  // computed name or a function.
  const refused = [
    "args.__proto__",
    "args.who.constructor",
    "send.constructor.constructor",
    "args.prototype",
    "({ __proto__: args })",
    "({ constructor: args })",
    "({ constructor })",
    'args["__proto__"]',
    'args["constructor"]',
    "args[args.who]",
    "args[1 + 1]",
    '"constructor" in args',
    "args instanceof args",
    "args.who.__lookupGetter__",
    "Object.keys(args)",
    "globalThis",
    "this",
    "(() => args)()",
    "args.lines.forEach((line) => line)",
    "args.lines.map(args.fn)",
    "Function('return this')()",
  ];

  it.each(refused)("refuses `%s`", (source) => {
    expect(problemsOf(reading(source)).length).toBeGreaterThan(0);
  });

  it("lets data's own fields named like a prototype's methods be read", () => {
    expect(
      [
        "args.values",
        "send.toString",
        // oxlint-disable-next-line no-template-curly-in-string -- an expression's template literal
        "`${args.who}`",
      ].map((source) => codesOf(reading(source)))
    ).toStrictEqual(["ok", "ok", "ok"]);
  });
});
