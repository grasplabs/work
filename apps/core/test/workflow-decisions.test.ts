/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { v } from "@grasp-os/sdk";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  answerDecision,
  confirmDecision,
  decisionEventType,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-drafts.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { repairWakes } from "../src/workflows/wakes.ts";
import { allEvents } from "./audit-events.ts";
import { resumed, stopped, whileEngineRefuses } from "./runs.ts";
import { outcome, unique } from "./sign-in.ts";

// `grasp.decision` in JSON workflows (GRA-941: @grasp-os/open-workflow's
// generate.ts, core's resource-host.ts, resource-decisions.ts and the
// decision service in src/decisions/), from its threat model: only the
// person the binding allows answers, never the run's own person, and only
// with their confirmation; the run takes the outcome from the decision,
// never from its wake; a decline or no answer never reaches `approved`;
// authority revoked while the run waits refuses the outcome; and a replay
// or a lost wake asks nothing twice. Spec 13.9's approval example runs as
// written, through the dispatcher, the engine and the decision service.

const identityOf = (userId: string, role: Role): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return identityOf(userId, role);
};

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** 13.9's `request-review` task, as the specification has it. */
const requestReview = {
  call: "grasp.decision",
  with: {
    binding: "invoiceApproval",
    recipients: "${ [$params.reviewer] }",
    prompt: "${ $params.approvalPrompt }",
    input: "${ $workflow.input }",
  },
  export: { as: "${ $context + {review: .} }" },
};

/** Spec 13.9's approval example, exactly as the specification has it. */
const approvalTasks = [
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
  { "request-review": requestReview },
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
];

/**
 * The document around a task list, as 13.9 describes the approval
 * example's: integer `approvalThreshold`, person `reviewer`, string
 * `approvalPrompt`, the `invoiceApproval` decision binding, input with a
 * numeric `amount` and the `{ status }` output.
 */
const definitionOf = (name: string, contract: string, tasks: unknown[]) =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
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
            invoiceApproval: { kind: "decision", contract },
          },
        },
      },
    },
    input: { schema: objectSchema({ amount: { type: "number" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** What a reviewer may answer with: a comment, or nothing. */
const response = v.union(v.null(), v.object({ comment: v.string() }));

interface Setup {
  /**
   * Its deciders, as the admin approves the binding, made ready for them:
   * the reviewer's own by default.
   */
  deciders?: (reviewer: Identity) => Promise<string[]>;
  tasks?: unknown[];
  /** What its contract takes as an answer's payload. */
  answers?: { descriptor: unknown };
}

/**
 * The approval workflow of `owner`'s, published from `tasks`, its decision
 * binding approved by an admin for `deciders`, its reviewer `reviewer`.
 */
const approvalWorkflow = async ({
  deciders = async (reviewer) =>
    await Promise.resolve([`person:${reviewer.userId}`]),
  tasks = approvalTasks,
  answers = response,
}: Setup = {}) => {
  const admin = await person("admin");
  const owner = await person("builder");
  const reviewer = await person("user");
  const contract = `invoice-approval-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "decision",
    input: JSON.stringify(v.object({ amount: v.number() }).descriptor),
    response: JSON.stringify(answers.descriptor),
  });
  const workflow = await createWorkflowResource(
    env,
    owner,
    `approve-${unique()}`
  );
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: definitionOf(workflow.name, contract, tasks),
    basedOn: null,
  });
  const [version] = await workflowVersions(env, owner, workflow.id);
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "invoiceApproval",
    target: { kind: "decision", deciders: await deciders(reviewer) },
    reviewed: { version: 1 },
  });
  await setWorkflowParams(env, owner, workflow.id, {
    values: { reviewer: reviewer.userId },
    expectedRevision: 0,
  });
  return { admin, owner, reviewer, workflow, version, approval };
};

/** Starts version 1 of workflow `id` for `by`, on an invoice of `amount`. */
const started = async (
  by: Identity,
  id: string,
  amount: number
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { amount }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** Run `runId` of workflow `id` once it has ended. */
const ended = async (
  by: Identity,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** What a run ended with: its status, and its output or error code. */
const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** The decisions run `runId` opened, as their rows have them. */
const decisionsOf = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, deciders, description, status, input, starter_excluded FROM workflow_decisions WHERE resource_run_id = ?"
  )
    .bind(runId)
    .all<{
      id: string;
      deciders: string;
      description: string;
      status: string;
      input: string | null;
      starter_excluded: number;
    }>();
  return results;
};

/** How many decisions run `runId` opened. */
const decisionCount = async (runId: string): Promise<number> => {
  const rows = await decisionsOf(runId);
  return rows.length;
};

/** The decision run `runId` opened, once it has. */
const openedBy = async (runId: string): Promise<string> =>
  await vi.waitFor(
    async () => {
      const [decision] = await decisionsOf(runId);
      if (decision === undefined) {
        throw new Error("No decision yet");
      }
      return decision.id;
    },
    { timeout: 20_000, interval: 100 }
  );

/**
 * `by`'s answer to `decision` through the trusted host decision UI:
 * reviewed, confirmed, then answered with that confirmation.
 */
const confirmedAnswer = async (
  by: Identity,
  decision: string,
  answer: { approved: boolean; payload?: { comment: string } }
) => {
  const review = await reviewDecision(env, by, decision, answer);
  if (review.state === "recorded") {
    return review.decision;
  }
  const { confirmation } = await confirmDecision(
    env,
    by,
    decision,
    review.decision.revision,
    review.response
  );
  return await answerDecision(env, by, decision, review.response, confirmation);
};

/** The receipts of run `runId`'s decision calls, by outcome. */
const receiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target, detail }) =>
        action === "workflow.run.called" &&
        target?.id === runId &&
        detail?.call === "grasp.decision"
    )
    .map(({ detail }) => detail?.outcome);
};

/** How often decision `decision` was opened, as the audit log has it. */
const openings = async (decision: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "workflow.decision.opened" && target?.id === decision
  ).length;
};

describe("spec 13.9's approval example", () => {
  it("publishes as written, executable, against the build its run loads", async () => {
    const { version } = await approvalWorkflow();
    expect({
      executable: version?.build.executable,
    }).toStrictEqual({ executable: true });
  });

  it("takes the approved branch once the reviewer approves, the decision showing what it is about", async () => {
    const { owner, reviewer, workflow } = await approvalWorkflow();
    const runId = await started(owner, workflow.id, 5000);
    const decision = await openedBy(runId);
    const answered = await confirmedAnswer(reviewer, decision, {
      approved: true,
      payload: { comment: "Matches the PO" },
    });
    const run = await ended(owner, workflow.id, runId);
    const [row] = await decisionsOf(runId);
    expect({
      answered: {
        status: answered.status,
        input: answered.input,
        description: answered.description,
        workflowResource: answered.workflowResource?.id,
        app: answered.app,
      },
      row: {
        deciders: row?.deciders,
        starterExcluded: row?.starter_excluded,
      },
      end: endOf(run),
      // A replay after the answer opened nothing more: one decision, one
      // opening, one receipt of each half of the call.
      decisions: await decisionCount(runId),
      openings: await openings(decision),
      receipts: await receiptsOf(runId),
    }).toStrictEqual({
      answered: {
        status: "approved",
        input: { amount: 5000 },
        description: "Approve this invoice?",
        workflowResource: workflow.id,
        app: undefined,
      },
      row: { deciders: `person:${reviewer.userId}`, starterExcluded: 1 },
      end: { status: "completed", output: { status: "approved" } },
      decisions: 1,
      openings: 1,
      receipts: ["opened", "answered"],
    });
  });

  it("takes the rejected branch when the reviewer declines: a decline never falls through to approved", async () => {
    const { owner, reviewer, workflow } = await approvalWorkflow();
    const runId = await started(owner, workflow.id, 5000);
    const decision = await openedBy(runId);
    await confirmedAnswer(reviewer, decision, { approved: false });
    const run = await ended(owner, workflow.id, runId);
    expect(endOf(run)).toStrictEqual({
      status: "completed",
      output: { status: "rejected" },
    });
  });

  it("takes the approved branch for a small invoice without asking anyone", async () => {
    const { owner, workflow } = await approvalWorkflow();
    const runId = await started(owner, workflow.id, 10);
    const run = await ended(owner, workflow.id, runId);
    expect({
      end: endOf(run),
      decisions: await decisionsOf(runId),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "approved" } },
      decisions: [],
    });
  });
});

describe("who answers a JSON workflow's decision", () => {
  it("is only its recipient, confirmed: not the run's person, an admin, another member, nor an event of its type", async () => {
    const { admin, owner, reviewer, workflow } = await approvalWorkflow();
    const other = await person("user");
    const runId = await started(owner, workflow.id, 5000);
    const decision = await openedBy(runId);
    const tries = {
      owner: await outcome(
        confirmDecision(env, owner, decision, "", { approved: true })
      ),
      admin: await outcome(
        confirmDecision(env, admin, decision, "", { approved: true })
      ),
      other: await outcome(
        reviewDecision(env, other, decision, { approved: true })
      ),
      // The recipient without a confirmation: nothing is recorded.
      unconfirmed: await outcome(
        answerDecision(env, reviewer, decision, { approved: true }, "")
      ),
    };
    // A stray event of the decision's wake type, as anyone with the
    // engine could send: the run looks, finds nothing answered, and waits
    // on.
    await runEngine(env).sendEvent(
      runId,
      decisionEventType(decision),
      `forged:${unique()}`
    );
    await scheduler.wait(1000);
    const stillWaiting = await resourceRunFor(env, owner, workflow.id, runId);
    await confirmedAnswer(reviewer, decision, { approved: false });
    const run = await ended(owner, workflow.id, runId);
    expect({
      tries,
      waitingAfterForgedWake: stillWaiting.endedAt,
      end: endOf(run),
    }).toStrictEqual({
      tries: {
        owner: "decision.forbidden",
        admin: "decision.forbidden",
        other: "decision.forbidden",
        unconfirmed: "decision.unconfirmed",
      },
      waitingAfterForgedWake: null,
      end: { status: "completed", output: { status: "rejected" } },
    });
  });

  it("refuses an answer its contract doesn't take, leaving the decision open for one it does", async () => {
    const { owner, reviewer, workflow } = await approvalWorkflow({
      answers: v.object({ comment: v.string() }),
    });
    const runId = await started(owner, workflow.id, 5000);
    const decision = await openedBy(runId);
    const bare = await outcome(
      confirmedAnswer(reviewer, decision, { approved: true })
    );
    const [stillOpen] = await decisionsOf(runId);
    await confirmedAnswer(reviewer, decision, {
      approved: true,
      payload: { comment: "Matches the PO" },
    });
    const run = await ended(owner, workflow.id, runId);
    expect({
      bare,
      status: stillOpen?.status,
      end: endOf(run),
    }).toStrictEqual({
      bare: "decision.invalid",
      status: "open",
      end: { status: "completed", output: { status: "approved" } },
    });
  });

  it("refuses a recipient the binding doesn't cover, opening nothing", async () => {
    const { owner, workflow } = await approvalWorkflow({
      deciders: async () => await Promise.resolve(["role:admin"]),
    });
    const runId = await started(owner, workflow.id, 5000);
    const run = await ended(owner, workflow.id, runId);
    expect({
      end: endOf(run),
      decisions: await decisionsOf(runId),
      receipts: await receiptsOf(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_denied" },
      decisions: [],
      receipts: ["workflow.call_denied"],
    });
  });

  it("asks a member of a team the binding names", async () => {
    const teamId = crypto.randomUUID();
    const { owner, reviewer, workflow } = await approvalWorkflow({
      deciders: async (asked) => {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Finance', 'organization', ?)"
          ).bind(teamId, Date.now()),
          env.DB.prepare(
            "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), teamId, asked.userId, Date.now()),
        ]);
        return [`team:${teamId}`];
      },
    });
    const runId = await started(owner, workflow.id, 5000);
    const decision = await openedBy(runId);
    await confirmedAnswer(reviewer, decision, { approved: true });
    const run = await ended(owner, workflow.id, runId);
    expect(endOf(run)).toStrictEqual({
      status: "completed",
      output: { status: "approved" },
    });
  });
});

describe("authority behind a JSON workflow's decision", () => {
  it("refuses the outcome once the binding is revoked while the run waits, never taking it as approved", async () => {
    const { admin, owner, reviewer, workflow, approval } =
      await approvalWorkflow();
    const runId = await started(owner, workflow.id, 5000);
    const decision = await openedBy(runId);
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    await confirmedAnswer(reviewer, decision, { approved: true });
    const run = await ended(owner, workflow.id, runId);
    expect({
      end: endOf(run),
      receipts: await receiptsOf(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_denied" },
      receipts: ["opened", "workflow.call_denied"],
    });
  });

  it("refuses to open a decision once the binding is revoked before the call", async () => {
    const { admin, owner, workflow, approval } = await approvalWorkflow({
      tasks: [{ hold: { wait: "PT2S" } }, ...approvalTasks],
    });
    const runId = await started(owner, workflow.id, 5000);
    await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
    const run = await ended(owner, workflow.id, runId);
    expect({
      end: endOf(run),
      decisions: await decisionsOf(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_denied" },
      decisions: [],
    });
  });

  it("fails the call when nobody answers before the task's timeout: no outcome is made up", async () => {
    const [route, , ...rest] = approvalTasks;
    const timed = {
      "request-review": {
        ...requestReview,
        timeout: { after: { seconds: 2 } },
      },
    };
    const { owner, workflow } = await approvalWorkflow({
      tasks: [route, timed, ...rest],
    });
    const runId = await started(owner, workflow.id, 5000);
    const run = await ended(owner, workflow.id, runId);
    const rows = await decisionsOf(runId);
    const statuses = rows.map(({ status }) => status);
    expect({
      end: endOf(run),
      decisions: statuses,
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.decision_timed_out" },
      decisions: ["timed_out"],
    });
  });
});

describe("a JSON workflow's decision in a loop", () => {
  it("opens one decision per item, each answered on its own", async () => {
    const { owner, reviewer, workflow } = await approvalWorkflow({
      tasks: [
        {
          init: { set: "${ . }", export: { as: "${ {answers: []} }" } },
        },
        {
          "each-invoice": {
            for: { each: "amount", in: "${ [100, 200] }" },
            do: [
              {
                ask: {
                  ...requestReview,
                  with: {
                    ...requestReview.with,
                    input: "${ {amount: $amount} }",
                  },
                  export: {
                    as: "${ $context + {answers: ($context.answers + [.approved])} }",
                  },
                },
              },
            ],
          },
        },
        {
          finished: {
            set: '${ {status: ($context.answers | map(tostring) | join(","))} }',
          },
        },
      ],
    });
    const runId = await started(owner, workflow.id, 5000);
    const first = await openedBy(runId);
    await confirmedAnswer(reviewer, first, { approved: true });
    const second = await vi.waitFor(
      async () => {
        const rows = await decisionsOf(runId);
        const next = rows.find(({ id }) => id !== first);
        if (next === undefined) {
          throw new Error("No second decision yet");
        }
        return next.id;
      },
      { timeout: 20_000, interval: 100 }
    );
    await confirmedAnswer(reviewer, second, { approved: false });
    const run = await ended(owner, workflow.id, runId);
    const rows = await decisionsOf(runId);
    expect({
      end: endOf(run),
      inputs: rows
        .map(({ input }) => input)
        .toSorted((a, b) => String(a).localeCompare(String(b))),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "true,false" } },
      inputs: ['{"amount":100}', '{"amount":200}'],
    });
  });
});

describe("durability of a JSON workflow's decision", () => {
  it("goes on with the answer once when its wake is lost and the run restarts, asking nothing twice", async () => {
    const { owner, reviewer, workflow } = await approvalWorkflow();
    const runId = await started(owner, workflow.id, 5000);
    const decision = await openedBy(runId);
    // Down while it waits, and the engine unreachable as the answer comes
    // in: the answer is recorded, and the wake it owes is lost.
    await stopped(runId);
    await whileEngineRefuses(
      (method) => method === "sendEvent",
      async () => await confirmedAnswer(reviewer, decision, { approved: true })
    );
    // The same answer again, as after an acknowledgement that never came:
    // the decision already taken. Another answer finds it closed.
    const again = await outcome(
      answerDecision(env, reviewer, decision, { approved: true }, "")
    );
    const other = await outcome(
      answerDecision(env, reviewer, decision, { approved: false }, "")
    );
    // The repair sends the wake while the run is down; it takes it once
    // it is back.
    await repairWakes(env, new Date(Date.now() + 60_000));
    await resumed(runId);
    const run = await ended(owner, workflow.id, runId);
    expect({
      again,
      other,
      end: endOf(run),
      decisions: await decisionCount(runId),
      openings: await openings(decision),
      receipts: await receiptsOf(runId),
    }).toStrictEqual({
      again: "ok",
      other: "decision.closed",
      end: { status: "completed", output: { status: "approved" } },
      decisions: 1,
      openings: 1,
      receipts: ["opened", "answered"],
    });
  });
});

describe("a test run of a JSON workflow's decision", () => {
  it("asks nobody: its fixture answers, held to a decision's outcome and the contract's response", async () => {
    const admin = await person("admin");
    const owner = await person("builder");
    const contract = `invoice-approval-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "decision",
      input: JSON.stringify(v.object({ amount: v.number() }).descriptor),
      response: JSON.stringify(response.descriptor),
    });
    const workflow = await createWorkflowResource(
      env,
      owner,
      `approve-${unique()}`
    );
    const { revision: base } = await workflowDraft(env, owner, workflow.id);
    const saved = await editWorkflowDraft(env, owner, workflow.id, {
      expectedRevision: base,
      source: definitionOf(workflow.name, contract, approvalTasks),
      modules: {},
    });
    const run = async (answer: unknown) => {
      const { runId } = await startCandidateRun(env, owner, workflow.id, {
        revision: saved.revision,
        input: { amount: 5000 },
        params: { reviewer: crypto.randomUUID() },
        fixtures: { invoiceApproval: { output: answer } },
      });
      const ran = await vi.waitFor(
        async () => {
          const found = await candidateRunFor(env, owner, workflow.id, runId);
          if (found.status === "starting" || found.status === "running") {
            throw new Error(`Test run ${runId} is ${found.status}`);
          }
          return found;
        },
        { timeout: 20_000, interval: 100 }
      );
      return {
        end:
          ran.status === "completed"
            ? { status: ran.status, output: ran.output }
            : { status: ran.status, code: ran.error?.code },
        decisions: await decisionCount(runId),
      };
    };
    expect({
      problems: saved.problems,
      declined: await run({
        answered: true,
        approved: false,
        by: "fixture",
        value: null,
      }),
      // Not a decision's outcome: refused, never read as approved.
      approvedOnly: await run({ approved: true }),
      offContract: await run({
        answered: true,
        approved: true,
        by: "fixture",
        value: { comment: 7 },
      }),
    }).toStrictEqual({
      problems: [],
      declined: {
        end: { status: "completed", output: { status: "rejected" } },
        decisions: 0,
      },
      approvedOnly: {
        end: { status: "failed", code: "workflow.call_invalid" },
        decisions: 0,
      },
      offContract: {
        end: { status: "failed", code: "workflow.call_invalid" },
        decisions: 0,
      },
    });
  });
});
