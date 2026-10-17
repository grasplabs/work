import type {
  RunHistoryEntry,
  RunHistoryPage,
} from "@grasp-os/shared/workflows";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { approvalApp, confirmedAnswer, week } from "./decisions.ts";
import type { Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, runObject } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, hitCall, workflowFiles } from "./workflow-apps.ts";

// A run's history, as Grasp's run pages read it (history.ts): projected
// from the engine's journal, page by page. What could go wrong, tried
// below: a retry counted as a second step, or a replay as another
// attempt; a step's last failure told twice; an output, an input, a
// reviewer or a failure's message reaching someone who mustn't read it;
// a page skipping or repeating an entry; a person who lost their role
// reading on; another App's run read; a run's history outliving its
// details.

const idp = mockIdp();

const personApi = async (role: "admin" | "builder" | "user") =>
  await signedInApi(idp, role);

/** Every entry of the run's history, `pageSize` at a time, as `person` reads it. */
const historyOf = async (
  person: Person,
  run: string,
  pageSize = 100
): Promise<{ entries: RunHistoryEntry[]; pages: RunHistoryPage[] }> => {
  const pages: RunHistoryPage[] = [];
  let cursor: string | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
    const page: RunHistoryPage = await person.api.workflows.history(run, {
      pageSize,
      cursor,
    });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { entries: pages.flatMap(({ items }) => items), pages };
};

/** What an entry says, without its times and IDs. */
const said = (entry: RunHistoryEntry): string => {
  switch (entry.kind) {
    case "lifecycle": {
      return `run ${entry.status}`;
    }
    case "step":
    case "compensation": {
      return `${entry.kind} ${entry.taskId} ${entry.state} ${entry.attempt}`;
    }
    case "wait": {
      return `wait ${entry.taskId} ${entry.waitKind} ${entry.state}`;
    }
    case "unreadable": {
      return "unreadable";
    }
    default: {
      return entry satisfies never;
    }
  }
};

/**
 * A step whose first two attempts hang past their timeout, its third
 * returning the run's input, then a sleep, then a step that throws.
 */
const flaky = workflowFiles(
  "flaky",
  `  const counted = await step.do(
    "count",
    { description: "Count", timeout: "1 second", retries: { limit: 2, delay: 1, backoff: "constant" } },
    async () => {
      const tries = await ${hitCall(`"count"`)};
      if (tries < 3) {
        await new Promise(() => {});
      }
      return { input, tries };
    }
  );
  await step.sleep("nap", { description: "Nap", duration: 1 });
  await step.do("check", { description: "Check", retries: { limit: 0 } }, async () => {
    throw Object.assign(new Error("Customer " + counted.input.secret + " is blocked"), { code: "customer.blocked" });
  });`,
  { count: { input: {}, tries: 3 }, check: null }
);

describe("a run's history", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("tells one step's retries as its attempts, its sleep, and its last failure once, without its values", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, flaky);
    const secret = `secret-${crypto.randomUUID()}`;
    const run = await builder.api.workflows.start(app, "flaky", { secret });
    await finished(run.id);

    const { entries, pages } = await historyOf(builder, run.id, 3);
    const { entries: whole } = await historyOf(builder, run.id);
    const counts = entries.filter(
      (entry) => entry.kind === "step" && entry.taskId === "count"
    );

    // Whether the run suspends between attempts is the engine's timing;
    // what its steps did isn't.
    const lifecycle = entries.filter(({ kind }) => kind === "lifecycle");
    expect({
      steps: entries.filter(({ kind }) => kind !== "lifecycle").map(said),
      lifecycle: [...lifecycle.slice(0, 2), ...lifecycle.slice(-1)].map(said),
    }).toStrictEqual({
      steps: [
        "step count started 1",
        "step count retrying 1",
        "step count started 2",
        "step count retrying 2",
        "step count started 3",
        "step count completed 3",
        "wait nap timer opened",
        "wait nap timer closed",
        "step check started 1",
        "step check failed 1",
      ],
      lifecycle: ["run queued", "run running", "run failed"],
    });
    expect({
      // Paged or not, the same entries, in the engine's order, each once.
      paged: entries,
      ordered: entries.every(
        ({ sequence }, index) =>
          index === 0 || sequence > (entries[index - 1]?.sequence ?? Infinity)
      ),
      // One logical step: every attempt of it is one step ID.
      steps: new Set(
        counts.map((entry) => entry.kind === "step" && entry.stepId)
      ).size,
      lastPage: pages.at(-1)?.hasMore,
      failed: entries.find(
        (entry) => entry.kind === "step" && entry.state === "failed"
      ),
    }).toMatchObject({
      paged: whole,
      ordered: true,
      steps: 1,
      lastPage: false,
      failed: {
        taskId: "check",
        error: {
          code: "customer.blocked",
          message: `Customer ${secret} is blocked`,
        },
      },
    });
    // The run's input, and what its steps returned, stay with the engine:
    // only the failure's own message, to its person, quotes what it read.
    expect(
      JSON.stringify(
        whole.filter(
          (entry) => entry.kind !== "step" || entry.state !== "failed"
        )
      )
    ).not.toContain(secret);
  });

  it("shows a failure's message and App code only to those who see the run's details, and nothing to someone with a role only in another App or once its details are removed", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const outsider = await personApi("user");
    const admin = await personApi("admin");
    const app = await appWith(
      builder,
      workflowFiles(
        "failing",
        `  return await step.do("fail", { description: "Fail", retries: { limit: 0 } }, async () => {
    throw Object.assign(new Error("Invoice INV-7 of Acme is missing"), { code: "invoice.missing" });
  });`,
        { fail: null }
      )
    );
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    // A role in another App opens none of this one's runs.
    const elsewhere = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    await builder.api.apps.members.add(elsewhere, {
      type: "person",
      id: outsider.userId,
      role: "user",
    });
    const run = await builder.api.workflows.start(app, "failing");
    await finished(run.id);
    const failureFor = async (person: Person) => {
      const { entries } = await historyOf(person, run.id);
      return entries.find(
        (entry) => entry.kind === "step" && entry.state === "failed"
      );
    };

    const own = await failureFor(builder);
    const other = await failureFor(user);
    const byAdmin = await failureFor(admin);
    const refused = await outcome(outsider.api.workflows.history(run.id));
    const unknown = await outcome(
      builder.api.workflows.history(crypto.randomUUID())
    );
    const invalid = await outcome(
      builder.api.workflows.history(run.id, { cursor: "0" })
    );
    // The person loses their role: their next page is refused.
    await builder.api.apps.members.remove(app, {
      type: "person",
      id: user.userId,
    });
    const revoked = await outcome(user.api.workflows.history(run.id));
    await env.DB.prepare(
      "UPDATE workflow_runs SET details_removed_at = ? WHERE id = ?"
    )
      .bind(Date.now(), run.id)
      .run();
    const removed = await builder.api.workflows.history(run.id);

    expect({
      own: own?.kind === "step" && own.state === "failed" && own.error,
      other: other?.kind === "step" && other.state === "failed" && other.error,
      byAdmin:
        byAdmin?.kind === "step" && byAdmin.state === "failed" && byAdmin.error,
      refused,
      unknown,
      invalid,
      revoked,
      removed,
    }).toStrictEqual({
      own: {
        code: "invoice.missing",
        message: "Invoice INV-7 of Acme is missing",
      },
      // An App's own code can be what it read, as its message can.
      other: {
        code: "workflow.step_failed",
        message: "A step of the workflow failed.",
      },
      byAdmin: {
        code: "invoice.missing",
        message: "Invoice INV-7 of Acme is missing",
      },
      refused: "app.not_found",
      unknown: "workflow.run_not_found",
      invalid: "workflow.invalid",
      revoked: "app.not_found",
      removed: { items: [], nextCursor: null, hasMore: false },
    });
  });

  it("tells a decision's wait by the decision, and leaves out the platform's own steps and who answered", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const app = await approvalApp(builder);
    const run = await builder.api.workflows.start(app, "approval", {
      from: "role:admin",
      timeout: week,
    });
    const decision = await vi.waitFor(
      async () => {
        const found = await env.DB.prepare(
          "SELECT id FROM workflow_decisions WHERE run_id = ?"
        )
          .bind(run.id)
          .first<{ id: string }>();
        if (found === null) {
          throw new Error("No decision yet");
        }
        return found.id;
      },
      { timeout: 20_000, interval: 100 }
    );
    const waiting = await vi.waitFor(
      async () => {
        const { entries } = await historyOf(builder, run.id);
        if (!entries.some((entry) => entry.kind === "wait")) {
          throw new Error("Not waiting yet");
        }
        return entries;
      },
      { timeout: 20_000, interval: 100 }
    );
    await confirmedAnswer(admin, decision, { approved: true });
    await finished(run.id);
    const { entries } = await historyOf(builder, run.id);
    const waits = entries.filter((entry) => entry.kind === "wait");

    expect({
      waits: waits.map(
        (entry) =>
          entry.kind === "wait" && [entry.waitId, entry.waitKind, entry.state]
      ),
      open: waiting.filter((entry) => entry.kind === "wait").length,
      tasks: [...new Set(entries.map(({ taskId }) => taskId))],
      last: entries.map(said).at(-1),
    }).toStrictEqual({
      waits: [
        [decision, "decision", "opened"],
        [decision, "decision", "closed"],
      ],
      open: 1,
      // The approval workflow asks whoever its input names, so its review
      // can't read its steps: no entry names a task.
      tasks: [null],
      last: "run completed",
    });
    expect(JSON.stringify(entries)).not.toContain(admin.userId);
  });

  it("names a task only by a name the review shows, never by a step's key or a name made of what the run read", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      // Keyed by the customer: the key is the App's data.
      ...workflowFiles(
        "keyed",
        `  await step.do("charge", { description: "Charge", key: String(input?.customer) }, async () => 1);`,
        { charge: 1 }
      ),
      // A name made of the input: the review can't read the steps.
      ...workflowFiles(
        "dynamic",
        `  await step.do("charge-" + String(input?.customer), { description: "Charge" }, async () => 1);`,
        { "charge-undefined": 1 }
      ),
    });
    const customer = `customer-${crypto.randomUUID()}`;
    const keyed = await builder.api.workflows.start(app, "keyed", {
      customer,
    });
    const dynamic = await builder.api.workflows.start(app, "dynamic", {
      customer,
    });
    await Promise.all([finished(keyed.id), finished(dynamic.id)]);

    const { entries: ofKeyed } = await historyOf(builder, keyed.id);
    const { entries: ofDynamic } = await historyOf(builder, dynamic.id);

    expect({
      keyed: [
        ...new Set(
          ofKeyed
            .filter(({ kind }) => kind === "step")
            .map(({ taskId }) => taskId)
        ),
      ],
      dynamic: [
        ...new Set(
          ofDynamic
            .filter(({ kind }) => kind === "step")
            .map(({ taskId }) => taskId)
        ),
      ],
    }).toStrictEqual({ keyed: ["charge"], dynamic: [null] });
    expect(JSON.stringify([ofKeyed, ofDynamic])).not.toContain(customer);
  });

  it("tells an event the engine can't read back by its place alone, and the rest as it was", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, flaky);
    const run = await builder.api.workflows.start(app, "flaky", {
      secret: "s",
    });
    await finished(run.id);
    const { entries: before } = await historyOf(builder, run.id);
    const broken = before.find(
      (entry) => entry.kind === "step" && entry.state === "retrying"
    );
    await runInDurableObject(runObject(run.id), (_, state) => {
      state.storage.sql.exec(
        "UPDATE history SET detail = 'not json' WHERE seq = ?",
        broken?.sequence ?? 0
      );
    });

    const { entries: after } = await historyOf(builder, run.id, 4);

    expect(after).toStrictEqual(
      before.map((entry) =>
        entry === broken
          ? {
              id: entry.id,
              sequence: entry.sequence,
              taskId: null,
              at: entry.at,
              kind: "unreadable",
            }
          : entry
      )
    );
  });
});
