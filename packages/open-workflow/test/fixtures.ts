/* oxlint-disable unicorn/no-thenable -- `then` is Open Workflow's flow directive, not a promise */
/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";

import type { CatalogContract, ValidateOptions } from "../src/catalog.ts";

/**
 * The definitions of platform specification 13 (the note summary of 13.8
 * and every example of 13.9, inside the documents they describe), one
 * definition with every task kind and named call, and the host catalog
 * those documents' fixtures define.
 */

const text = (schema: { descriptor: unknown }): string =>
  JSON.stringify(schema.descriptor);

const note = v
  .object({
    _id: v.id("notes"),
    _rev: v.string(),
    title: v.string(),
    body: v.string(),
  })
  .nullable();

/** The fixture catalog: every contract key the documents below name. */
export const catalogEntries: Record<string, CatalogContract> = {
  "notes.get": {
    kind: "operation",
    input: text(v.object({ id: v.id("notes") })),
    output: text(note),
  },
  "notes.setSummary": {
    kind: "operation",
    input: text(
      v.object({
        id: v.id("notes"),
        expectedRevision: v.string(),
        summary: v.string().max(10_000),
      })
    ),
    output: text(v.object({ _rev: v.string() })),
  },
  "note-summary": { kind: "model" },
  "invoice-approval": {
    kind: "decision",
    input: text(v.object({ amount: v.number() })),
    response: text(v.object({ comment: v.string().optional() })),
  },
  "job-status": {
    kind: "connector",
    operations: {
      status: {
        input: text(v.object({ id: v.string() })),
        output: text(v.object({ state: v.string() })),
      },
    },
  },
  "job-events": {
    kind: "event",
    eventTypes: ["grasp.job.completed", "grasp.job.timeout"],
  },
  "grasp/summarize-note/1.0.0": {
    kind: "workflow",
    workflow: { namespace: "grasp", name: "summarize-note", version: "1.0.0" },
    input: text(v.object({ noteId: v.id("notes") })),
    output: text(v.object({ noteId: v.id("notes"), summary: v.string() })),
  },
  "invoice-total": {
    kind: "compute",
    input: text(v.array(v.number())),
    output: text(v.number()),
  },
};

/** The workflow's own modules: `local:` keys only. */
export const moduleEntries: Record<string, CatalogContract> = {
  "local:code/total.ts#total": {
    kind: "compute",
    input: text(v.array(v.number())),
    output: text(v.number()),
  },
};

export const options: ValidateOptions = {
  catalog: (key) =>
    Object.hasOwn(catalogEntries, key) ? catalogEntries[key] : undefined,
  modules: (key) =>
    Object.hasOwn(moduleEntries, key) ? moduleEntries[key] : undefined,
  ceilings: { maxSteps: 1000, maxModelCalls: 50, maxActiveMs: 3_600_000 },
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[]
): unknown => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});

const noteId = {
  type: "string",
  "x-grasp-value": { kind: "id", table: "notes" },
};

/** 13.8, verbatim. */
export const noteSummary = {
  document: {
    dsl: "1.0.3",
    namespace: "grasp",
    name: "summarize-note",
    version: "1.0.0",
    title: "Summarize note",
    metadata: {
      grasp: {
        profile: "grasp-open-workflow/1",
        params: {
          instructions: {
            schema: { type: "string", minLength: 1, maxLength: 10_000 },
            label: "Instructions",
            default:
              "Summarize the supplied note within the requested word limit.",
            sensitive: false,
          },
          maxWords: {
            schema: { type: "integer", minimum: 20, maximum: 500 },
            label: "Maximum summary words",
            default: 120,
            sensitive: false,
          },
        },
        bindings: {
          loadNote: { kind: "operation", contract: "notes.get" },
          saveSummary: { kind: "operation", contract: "notes.setSummary" },
          summaryModel: { kind: "model", contract: "note-summary" },
        },
        limits: { maxSteps: 20, maxModelCalls: 2, maxActiveMs: 120_000 },
      },
    },
  },
  evaluate: { language: "jq", mode: "strict" },
  input: { schema: objectSchema({ noteId }, ["noteId"]) },
  output: {
    schema: objectSchema(
      { noteId, summary: { type: "string", maxLength: 10_000 } },
      ["noteId", "summary"]
    ),
  },
  do: [
    {
      "load-note": {
        call: "grasp.operation",
        with: {
          binding: "loadNote",
          arguments: { id: "${ $workflow.input.noteId }" },
        },
        export: { as: "${ $context + {note: .} }" },
      },
    },
    {
      "require-note": {
        if: "${ $context.note == null }",
        raise: {
          error: {
            type: "urn:grasp:error:note.not_found",
            status: 404,
            title: "The note is unavailable.",
          },
        },
      },
    },
    {
      summarize: {
        call: "grasp.model",
        with: {
          binding: "summaryModel",
          instructions: "${ $params.instructions }",
          input: {
            title: "${ $context.note.title }",
            body: "${ $context.note.body }",
            maxWords: "${ $params.maxWords }",
          },
          outputSchema: objectSchema(
            { summary: { type: "string", maxLength: 10_000 } },
            ["summary"]
          ),
        },
        export: { as: "${ $context + {summary: .summary} }" },
      },
    },
    {
      "save-summary": {
        call: "grasp.operation",
        with: {
          binding: "saveSummary",
          arguments: {
            id: "${ $context.note._id }",
            expectedRevision: "${ $context.note._rev }",
            summary: "${ $context.summary }",
          },
        },
      },
    },
    {
      result: {
        set: {
          noteId: "${ $context.note._id }",
          summary: "${ $context.summary }",
        },
      },
    },
  ],
};

interface Frame {
  name: string;
  params?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  input: Record<string, unknown>;
  required: string[];
  output?: unknown;
  use?: unknown;
}

/** A whole document around a `do` list, as 13.9 describes each one. */
export const documentAround = (frame: Frame, tasks: unknown[]) => ({
  document: {
    dsl: "1.0.3",
    namespace: "grasp",
    name: frame.name,
    version: "1.0.0",
    title: frame.name,
    metadata: {
      grasp: {
        profile: "grasp-open-workflow/1",
        params: frame.params ?? {},
        bindings: frame.bindings ?? {},
      },
    },
  },
  input: { schema: objectSchema(frame.input, frame.required) },
  output: {
    schema: frame.output ?? {
      format: "json",
      document: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
    },
  },
  ...(frame.use === undefined ? {} : { use: frame.use }),
  do: tasks,
});

/** 13.9: invoice approval through a decision, branches joined explicitly. */
export const approval = documentAround(
  {
    name: "invoice-approval",
    params: {
      approvalThreshold: {
        schema: { type: "integer", minimum: 0 },
        label: "Approval threshold",
        default: 1000,
        sensitive: false,
      },
      reviewer: {
        schema: { type: "string", "x-grasp-value": { kind: "person" } },
        label: "Reviewer",
        required: true,
        sensitive: false,
      },
      approvalPrompt: {
        schema: { type: "string", minLength: 1 },
        label: "Approval prompt",
        default: "Approve this invoice?",
        sensitive: false,
      },
    },
    bindings: {
      invoiceApproval: { kind: "decision", contract: "invoice-approval" },
    },
    input: { amount: { type: "number" } },
    required: ["amount"],
  },
  [
    {
      route: {
        switch: [
          {
            large: {
              when: "${ $workflow.input.amount > $params.approvalThreshold }",
              then: "request-review",
            },
          },
          { small: { then: "approved" } },
        ],
      },
    },
    {
      "request-review": {
        call: "grasp.decision",
        with: {
          binding: "invoiceApproval",
          recipients: "${ [$params.reviewer] }",
          prompt: "${ $params.approvalPrompt }",
          input: "${ $workflow.input }",
        },
        export: { as: "${ $context + {review: .} }" },
      },
    },
    {
      "review-route": {
        switch: [
          {
            accepted: {
              when: "${ $context.review.approved == true }",
              then: "approved",
            },
          },
          { declined: { then: "rejected" } },
        ],
      },
    },
    { approved: { set: { status: "approved" }, then: "finished" } },
    { rejected: { set: { status: "rejected" }, then: "finished" } },
    { finished: { set: "${ . }" } },
  ]
);

/** 13.9: bounded polling of a connector, with exhaustion. */
export const polling = documentAround(
  {
    name: "poll-job",
    params: {
      maxIterations: {
        schema: { type: "integer", minimum: 1, maximum: 100 },
        label: "Most polls",
        default: 10,
        sensitive: false,
      },
      pollDelayMs: {
        schema: { type: "integer", "x-grasp-value": { kind: "duration" } },
        label: "Delay between polls",
        default: 1000,
        sensitive: false,
      },
    },
    bindings: { jobStatus: { kind: "connector", contract: "job-status" } },
    input: { jobId: { type: "string", minLength: 1 } },
    required: ["jobId"],
    output: {
      format: "json",
      document: {
        type: "object",
        properties: { state: { type: "string" } },
        required: ["state"],
        additionalProperties: false,
      },
    },
  },
  [
    {
      initialize: {
        set: { done: false, status: null },
        export: { as: "${ . }" },
      },
    },
    {
      poll: {
        for: {
          each: "attempt",
          in: "${ [range(0; $params.maxIterations)] }",
        },
        while: "${ $context.done == false }",
        do: [
          {
            "read-status": {
              call: "grasp.connector",
              with: {
                binding: "jobStatus",
                operation: "status",
                arguments: { id: "${ $workflow.input.jobId }" },
              },
              export: {
                as: '${ $context + {status: ., done: (.state == "completed")} }',
              },
            },
          },
          {
            "poll-delay": {
              if: "${ $context.done == false and ($attempt + 1) < $params.maxIterations }",
              wait: '${ "PT" + (($params.pollDelayMs / 1000) | tostring) + "S" }',
            },
          },
        ],
      },
    },
    {
      exhausted: {
        if: "${ $context.done == false }",
        raise: {
          error: {
            type: "urn:grasp:error:poll.timeout",
            status: 408,
            title: "The job did not complete within the polling limit.",
          },
        },
      },
    },
    { "job-result": { set: "${ $context.status }" } },
  ]
);

const childRun = (id: string, noteIdSource: string): unknown => ({
  [id]: {
    run: {
      workflow: {
        namespace: "grasp",
        name: "summarize-note",
        version: "1.0.0",
        input: { noteId: noteIdSource },
      },
    },
    metadata: { grasp: { binding: "summaryChild" } },
  },
});

const childFrame = {
  name: "summarize-notes",
  bindings: {
    summaryChild: { kind: "workflow", contract: "grasp/summarize-note/1.0.0" },
  },
  input: {
    noteIds: { type: "array", items: noteId, minItems: 2, maxItems: 1000 },
  },
  required: ["noteIds"],
  output: {
    format: "json",
    document: {
      type: "array",
      items: { type: "object", properties: {}, additionalProperties: false },
    },
  },
};

/** 13.9: two child runs in parallel, in declaration order. */
export const parallelChildren = documentAround(childFrame, [
  {
    summaries: {
      fork: {
        branches: [
          {
            "first-summary": {
              do: [
                childRun("summarize-first", "${ $workflow.input.noteIds[0] }"),
              ],
            },
          },
          {
            "second-summary": {
              do: [
                childRun("summarize-second", "${ $workflow.input.noteIds[1] }"),
              ],
            },
          },
        ],
        compete: false,
      },
    },
  },
]);

/** 13.9: the collection fragment, with a real child task and item keys. */
export const collection = documentAround(childFrame, [
  {
    "summarize-each": {
      for: { each: "noteId", in: "${ $workflow.input.noteIds }", at: "index" },
      do: [childRun("summarize-one", "${ $noteId }")],
      metadata: { grasp: { key: "${ $noteId }", concurrency: 4 } },
    },
  },
]);

/** 13.9: waiting for an event, with timeout recovery. */
export const eventRecovery = documentAround(
  {
    name: "await-job",
    bindings: { jobEvents: { kind: "event", contract: "job-events" } },
    input: { jobId: { type: "string", minLength: 1 } },
    required: ["jobId"],
  },
  [
    {
      "await-job": {
        try: [
          {
            completion: {
              listen: {
                to: {
                  one: {
                    with: {
                      type: "grasp.job.completed",
                      subject: "${ $workflow.input.jobId }",
                    },
                  },
                },
                read: "data",
              },
              timeout: { after: { hours: 24 } },
              metadata: { grasp: { binding: "jobEvents" } },
              output: { as: "${ .[0] }" },
            },
          },
        ],
        catch: {
          errors: {
            with: {
              type: "https://open-workflow-specification.org/spec/1.0.0/errors/timeout",
            },
          },
          as: "failure",
          do: [
            {
              "publish-timeout": {
                emit: {
                  event: {
                    with: {
                      type: "grasp.job.timeout",
                      subject: "${ $workflow.input.jobId }",
                      data: { jobId: "${ $workflow.input.jobId }" },
                    },
                  },
                },
                metadata: { grasp: { binding: "jobEvents" } },
              },
            },
            { "timeout-result": { set: { status: "timeout" }, then: "end" } },
          ],
        },
      },
    },
  ]
);

/**
 * Every task kind and named call of the profile, in one definition: the
 * calculation, retry and absolute-wait fragments of 13.9 among them.
 */
export const everyKind = documentAround(
  {
    name: "every-kind",
    params: {
      cutoff: {
        schema: { type: "integer", "x-grasp-value": { kind: "timestamp" } },
        label: "Cutoff",
        required: true,
        sensitive: false,
      },
    },
    bindings: {
      total: { kind: "compute", contract: "invoice-total" },
      localTotal: { kind: "compute", contract: "local:code/total.ts#total" },
      jobStatus: { kind: "connector", contract: "job-status" },
      jobEvents: { kind: "event", contract: "job-events" },
      loadNote: { kind: "operation", contract: "notes.get" },
      summaryModel: { kind: "model", contract: "note-summary" },
      summaryChild: {
        kind: "workflow",
        contract: "grasp/summarize-note/1.0.0",
      },
      invoiceApproval: { kind: "decision", contract: "invoice-approval" },
    },
    input: {
      amounts: { type: "array", items: { type: "number" } },
      jobId: { type: "string" },
      noteId,
      flag: { type: "boolean", default: false },
    },
    required: ["amounts", "jobId", "noteId"],
    use: {
      functions: {
        "read-job": {
          call: "grasp.connector",
          with: {
            binding: "jobStatus",
            operation: "status",
            arguments: { id: "${ $workflow.input.jobId }" },
          },
        },
      },
      errors: {
        overBudget: {
          type: "urn:grasp:error:budget.exceeded",
          status: 422,
          title: "The total is over budget.",
        },
      },
      retries: {
        idempotentRead: {
          delay: { seconds: 1 },
          limit: { attempt: { count: 3 } },
          backoff: { exponential: {} },
        },
      },
      timeouts: { short: { after: "PT30S" } },
    },
  },
  [
    {
      "calculate-total": {
        call: "grasp.compute",
        with: { binding: "total", arguments: "${ $workflow.input.amounts }" },
        export: { as: "${ $context + {total: .} }" },
      },
    },
    {
      "calculate-again": {
        call: "grasp.compute",
        with: { binding: "localTotal", arguments: [1, 2, 3] },
      },
    },
    {
      "read-with-retry": {
        try: [{ "read-job-once": { call: "read-job" } }],
        catch: {
          errors: {
            with: {
              type: "https://open-workflow-specification.org/spec/1.0.0/errors/communication",
            },
          },
          retry: {
            delay: { seconds: 1 },
            limit: { attempt: { count: 3 } },
            backoff: { exponential: {} },
          },
        },
      },
    },
    {
      "read-with-reusable-retry": {
        try: [{ "read-job-twice": { call: "read-job", timeout: "short" } }],
        catch: { retry: "idempotentRead" },
      },
    },
    {
      "load-note": {
        call: "grasp.operation",
        with: {
          binding: "loadNote",
          arguments: { id: "${ $workflow.input.noteId }" },
        },
      },
    },
    {
      "draft-summary": {
        call: "grasp.model",
        with: {
          binding: "summaryModel",
          instructions: "Summarize in one line.",
          input: "${ . }",
          outputSchema: objectSchema({ line: { type: "string" } }, ["line"]),
          maxOutputTokens: 200,
        },
      },
    },
    {
      "ask-approval": {
        call: "grasp.decision",
        with: {
          binding: "invoiceApproval",
          recipients: ["person:finance"],
          prompt: "Approve?",
          input: { amount: 10 },
        },
      },
    },
    { stamp: { call: "grasp.now" } },
    { jitter: { call: "grasp.random", with: {} } },
    {
      "until-cutoff": {
        call: "grasp.sleepUntil",
        with: { timestamp: "${ $params.cutoff }" },
      },
    },
    { pause: { wait: { minutes: 5 } } },
    { "short-pause": { wait: "PT1.5S" } },
    {
      "check-budget": {
        if: "${ $context.total > 1000 }",
        raise: { error: "overBudget" },
      },
    },
    {
      "in-steps": {
        do: [
          { "step-one": { set: { step: 1 } } },
          { "step-two": { set: { step: 2 }, then: "exit" } },
        ],
      },
    },
    {
      race: {
        fork: {
          compete: true,
          branches: [
            {
              "child-a": {
                run: {
                  workflow: {
                    namespace: "grasp",
                    name: "summarize-note",
                    version: "1.0.0",
                    input: { noteId: "${ $workflow.input.noteId }" },
                  },
                },
                metadata: {
                  grasp: { binding: "summaryChild", label: "Child A" },
                },
              },
            },
            {
              "listen-all": {
                listen: {
                  to: {
                    all: [
                      { with: { type: "grasp.job.completed" } },
                      {
                        with: { type: "grasp.job.timeout" },
                        correlate: {
                          job: {
                            from: "${ .subject }",
                            expect: "${ $workflow.input.jobId }",
                          },
                        },
                      },
                    ],
                  },
                  read: "envelope",
                },
                timeout: { after: { minutes: 10 } },
                metadata: { grasp: { binding: "jobEvents" } },
              },
            },
          ],
        },
        metadata: { grasp: { concurrency: 2, position: { x: 10, y: 20 } } },
      },
    },
    {
      "listen-any": {
        listen: {
          to: {
            any: [
              { with: { type: "grasp.job.completed" } },
              { with: { type: "grasp.job.timeout" } },
            ],
          },
        },
        timeout: "short",
        metadata: { grasp: { binding: "jobEvents" } },
      },
    },
    {
      announce: {
        emit: {
          event: {
            with: { type: "grasp.job.completed", data: "${ $context }" },
          },
        },
        metadata: { grasp: { binding: "jobEvents" } },
      },
    },
    {
      branch: {
        switch: [
          {
            flagged: {
              when: "${ $workflow.input.flag }",
              then: "flagged-result",
            },
          },
          { otherwise: { then: "plain-result" } },
        ],
      },
    },
    { "flagged-result": { set: { status: "flagged" }, then: "end" } },
    {
      "plain-result": {
        input: { from: "${ $context }" },
        set: { status: "plain" },
        output: { as: "${ . }" },
      },
    },
  ]
);

export const fixtures: Readonly<Record<string, unknown>> = {
  "13.8 note summary": noteSummary,
  "13.9 invoice approval": approval,
  "13.9 bounded polling": polling,
  "13.9 parallel children": parallelChildren,
  "13.9 collection": collection,
  "13.9 event recovery": eventRecovery,
  "every task kind and named call": everyKind,
};

/** A deep copy to change, as JSON text would give it. */
export const copy = <T>(value: T): T => structuredClone(value);
