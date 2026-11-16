import { v } from "@grasp-os/runtime/app";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { boundIn, testApp } from "../apps/core/test/app-definitions.ts";
import type { TestApp } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// A decision of an independent workflow, answered from an App's page
// end to end in a real browser (spec 10.7.2): the starter's page starts
// a run of the bound workflow; the reviewer's page lists the decision
// in its inbox (`queries.decisions`) and answers it through a decision
// form (`useForm` of the decision's value schema and an explicit approval,
// submitting `workflow.respond`). Grasp's own dialog, outside the frame,
// shows what would be recorded: cancelled, nothing is, and the draft
// stays; confirmed, the answer is recorded, the inbox empties without a
// refresh and the run goes on. The reviewer watches a run only while a
// decision of it asks them: one asking someone else, or one whose answer
// they gave, reads as no run at all, on a real engine. What else the host
// refuses, and every race of answers, are core's own tests
// (apps/core/test/page-workflow-decisions.test.ts).

// A trace of every failing page, kept as the run's artifact.
test.use({ trace: "retain-on-failure" });

/** How long a run's change may take to reach a page. */
const live = { timeout: 30_000 };

/** A value's schema: an object of exactly `fields`, each required. */
const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A native value descriptor of an object of string fields named `names`. */
const stringsDescriptor = (names: readonly string[]) =>
  v.object(Object.fromEntries(names.map((name) => [name, v.string()])))
    .descriptor;

/**
 * A workflow asking the person its input names (`reviewer`, a user ID) for
 * decision `contract`, as `approval`, in its step `ask`, then greeting.
 */
const definitionOf = (contract: string) =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({
      who: { kind: "string" },
      reviewer: { kind: "string" },
    }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: { $expr: '"Hello, " + args.who' } },
    permissions: { decisions: { approval: { contract } } },
    steps: [
      {
        id: "ask",
        type: "decide",
        decision: "approval",
        recipients: { $expr: '["person:" + args.reviewer]' },
        prompt: "Greet them?",
        input: { who: { $expr: "args.who" } },
      },
    ],
  });

/**
 * The App: it declares the `followUp` workflow; its page starts runs of
 * it asking `admin` or `colleague` (user IDs), shows the latest one's ID
 * and status, watches any run by its ID, and lists the decisions waiting
 * for the person, each answered through its own decision form.
 */
const appFiles = (admin: string, colleague: string): TestApp =>
  testApp(
    {
      name: "Requests",
      tables: {
        requests: {
          fields: { who: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: [
        'permission.workflow("followUp", {\n  args: v.object({ who: v.string().trim().min(1), reviewer: v.string() }),\n  returns: v.object({ status: v.string() }),\n})',
      ],
      // Its decision, as the version bound asks it.
      contracts: {
        followUp: {
          events: {},
          listens: {},
          decisions: {
            approval: {
              value: stringsDescriptor(["comment"]),
              context: stringsDescriptor(["who"]),
            },
          },
        },
      },
    },
    {
      "server/requests.ts": `import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;
`,

      "src/components/review.tsx": `import type { WorkflowDecisionInboxItem } from "@grasp-os/sdk";
import { useForm, useWorkflow } from "@grasp-os/sdk/react";
import { Form, FormError, SubmitButton, TextField } from "@grasp-os/ui/form";
import { workflows } from "@server/_generated/api";

/** One waiting decision, answered through its own form, mounted per item. */
export const Review = ({
  item,
}: {
  item: WorkflowDecisionInboxItem<"approval", { comment: string }>;
}) => {
  const workflow = useWorkflow(workflows.followUp, { runId: item.run.runId });
  const form = useForm(workflows.followUp.decisions.approval, {
    defaultValues: { approved: false, value: { comment: "" } },
    onSubmit: async (response) => await workflow.respond(item.wait, response),
  });
  return (
    <Form aria-label={\`Answer \${item.wait.title}\`} form={form}>
      <form.Field name="approved">
        {(field) => (
          <fieldset>
            <legend>Your answer</legend>
            <label>
              <input
                checked={field.state.value}
                name="answer"
                onChange={() => field.handleChange(true)}
                type="radio"
              />
              Approve
            </label>
            <label>
              <input
                checked={!field.state.value}
                name="answer"
                onChange={() => field.handleChange(false)}
                type="radio"
              />
              Reject
            </label>
          </fieldset>
        )}
      </form.Field>
      <TextField form={form} label="Comment" name="value.comment" />
      <FormError form={form} />
      <SubmitButton form={form}>Send answer</SubmitButton>
    </Form>
  );
};
`,
      "src/components/watched.tsx": `import { useWorkflow } from "@grasp-os/sdk/react";
import { workflows } from "@server/_generated/api";

/** Run \`runId\`'s status, as the person may see it: \`unavailable\` otherwise. */
export const Watched = ({ runId }: { runId: string }) => {
  const run = useWorkflow(workflows.followUp, { runId });
  return <output aria-label="Watched status">{run.status}</output>;
};
`,
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useWorkflow } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { workflows } from "@server/_generated/api";
import { Review } from "../components/review.tsx";
import { Watched } from "../components/watched.tsx";

const Desk = () => {
  const followUp = useWorkflow(workflows.followUp);
  const inbox = useQuery(workflows.followUp.queries.decisions, {
    pagination: {},
  });
  const [runId, setRunId] = useState("");
  const [watching, setWatching] = useState<string | null>(null);
  return (
    <main>
      <h1>Follow-ups</h1>
      <output aria-label="Status">{followUp.status}</output>
      <output aria-label="Run">
        {followUp.status === "idle" ? "" : followUp.runId}
      </output>
      <Button
        onClick={() => void followUp.start({ who: "Ada", reviewer: "${admin}" })}
      >
        Start follow-up
      </Button>
      <Button
        onClick={() =>
          void followUp.start({ who: "Grace", reviewer: "${colleague}" })
        }
      >
        Start colleague&apos;s follow-up
      </Button>
      <label>
        Run to watch
        <input onChange={(event) => setRunId(event.target.value)} value={runId} />
      </label>
      <Button onClick={() => setWatching(runId)}>Watch</Button>
      {watching === null ? null : <Watched runId={watching} />}
      <h2>Waiting for you</h2>
      <ul aria-label="Decisions">
        {(inbox?.items ?? []).map((item) => (
          <li key={item.wait.id}>
            <Review item={item} />
          </li>
        ))}
      </ul>
    </main>
  );
};
export const Route = createFileRoute("/")({ component: Desk });
`,
    }
  );

/**
 * A new App of `appFiles` whose `followUp` binds version 1 of a new
 * workflow of `builder`'s asking `admin` or `colleague`, its decision
 * binding approved for them, released and live, its
 * `start` grant given by `admin`. Bound
 * before the release, so the pages' `workflows.followUp` names the
 * decision.
 */
const boundApp = async (
  builder: Person,
  admin: Person,
  colleague: Person
): Promise<string> => {
  const builds = apiOf(builder);
  const decides = apiOf(admin);
  try {
    const key = `greeting-${crypto.randomUUID().slice(0, 8)}`;
    await decides.api.workflowResources.publishContract({
      key,
      kind: "decision",
      input: JSON.stringify(stringsDescriptor(["who"])),
      response: JSON.stringify(stringsDescriptor(["comment"])),
    });
    const { id: app } = await builds.api.apps.create({
      name: `Requests ${crypto.randomUUID().slice(0, 8)}`,
    });
    await builds.api.apps.members.add(app, {
      type: "person",
      id: colleague.userId,
      role: "user",
    });
    const workflow = await builds.api.workflowResources.create(
      `greet-${crypto.randomUUID().slice(0, 8)}`
    );
    // A new workflow's draft is at revision 0: written, then published.
    await builds.api.drafts.write({ kind: "workflow", id: workflow.id }, 0, {
      "workflow.json": definitionOf(key),
    });
    await builds.api.drafts.publish({ kind: "workflow", id: workflow.id }, 1);
    await decides.api.workflowResources.approveBinding(workflow.id, {
      alias: "approval",
      target: {
        kind: "decision",
        deciders: [`person:${admin.userId}`, `person:${colleague.userId}`],
      },
      reviewed: { version: 1 },
    });
    // Published from its draft, binding the workflow as it goes live.
    await release(
      builds.api,
      app,
      boundIn(appFiles(admin.userId, colleague.userId), {
        followUp: workflow.id,
      })
    );
    const { id } = await builds.api.permissions.request({
      subject: { type: "app", appId: app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "FOLLOW_UP",
    });
    await decides.api.permissions.grant(id, { version: 1 });
    return app;
  } finally {
    builds.core[Symbol.dispose]();
    decides.core[Symbol.dispose]();
  }
};

/**
 * Opens the desk page, once it shows. The first open of an App's
 * page builds it, which on a loaded machine takes longer than the
 * default 5 seconds.
 */
const openDesk = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  await expect(
    appPage.getByRole("heading", { name: "Follow-ups" })
  ).toBeVisible({ timeout: 20_000 });
  return appPage;
};

const decisionsOn = (appPage: FrameLocator) =>
  appPage.getByRole("list", { name: "Decisions" }).getByRole("listitem");

/** The ID of the run `page` started last, once it shows it running. */
const startedRun = async (
  appPage: FrameLocator,
  button: string
): Promise<string> => {
  const run = appPage.getByRole("status", { name: "Run" });
  const before = (await run.textContent()) ?? "";
  await appPage.getByRole("button", { name: button }).click();
  await expect(run).not.toHaveText(before, live);
  await expect(appPage.getByRole("status", { name: "Status" })).toHaveText(
    "running",
    live
  );
  return (await run.textContent()) ?? "";
};

/** Watches run `runId` on `page`, through `useWorkflow({ runId })`. */
const watch = async (appPage: FrameLocator, runId: string): Promise<void> => {
  await appPage.getByRole("textbox", { name: "Run to watch" }).fill(runId);
  await appPage.getByRole("button", { name: "Watch" }).click();
};

/**
 * What `useWorkflow` shows of a run the person may not see: no run at
 * all, nothing of what it is or returned, and no error.
 */
const watchedStatus = (appPage: FrameLocator) =>
  appPage.getByRole("status", { name: "Watched status" });

test("a reviewer answers a run's decision through a decision form on a page, confirmed in Grasp's own dialog, and watches only a run whose decision asks them now", async ({
  pageOf,
}) => {
  const { builder, admin, colleague } = peopleIn("pageDecisionForm");
  const app = await boundApp(builder, admin, colleague);
  const [first, second, third] = await Promise.all([
    pageOf(builder),
    pageOf(admin),
    pageOf(colleague),
  ]);
  const [starter, reviewer, other] = await Promise.all([
    openDesk(first, app),
    openDesk(second, app),
    openDesk(third, app),
  ]);

  // The starter starts a run asking the reviewer, and one asking their
  // colleague: each waits for its decision, which only the person it asks
  // has in their inbox, without a refresh.
  const asked = await startedRun(starter, "Start follow-up");
  const notAsked = await startedRun(starter, "Start colleague's follow-up");
  await expect(decisionsOn(reviewer)).toHaveCount(1, live);
  await expect(decisionsOn(other)).toHaveCount(1, live);
  await expect(decisionsOn(starter)).toHaveCount(0);
  await expect(decisionsOn(reviewer)).toHaveCount(1);

  // A run whose decision asks someone else is none of the reviewer's to
  // watch: it reads as no run at all.
  await watch(reviewer, notAsked);
  await expect(watchedStatus(reviewer)).toHaveText("unavailable", live);
  const desk = await openDesk(second, app);

  // The reviewer chooses to approve and writes a comment: nothing is sent
  // until they submit, and then Grasp's own dialog, outside the frame,
  // shows what would be recorded. Cancelled, nothing is: the decision
  // still waits, and the draft is still there to send.
  await expect(decisionsOn(desk)).toHaveCount(1, live);
  const form = decisionsOn(desk).first();
  await form.getByRole("radio", { name: "Approve" }).check();
  await form.getByRole("textbox", { name: "Comment" }).fill("Looks right");
  await form.getByRole("button", { name: "Send answer" }).click();
  const confirmation = second.getByRole("alertdialog", {
    name: "Confirm your approval",
  });
  await expect(confirmation).toBeVisible(live);
  await expect(confirmation).toContainText("Greet them?");
  await expect(confirmation).toContainText("Looks right");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toBeHidden();
  await expect(decisionsOn(desk)).toHaveCount(1);
  await expect(form.getByRole("textbox", { name: "Comment" })).toHaveValue(
    "Looks right"
  );
  await expect(form.getByRole("radio", { name: "Approve" })).toBeChecked();

  // Sent again (the page holds a cancelled answer back a while, so the
  // page can't keep the reviewer behind its dialog) and confirmed: the
  // answer is recorded, the inbox empties on its own, and the run goes on
  // to its end for the starter.
  await expect(async () => {
    if (!(await confirmation.isVisible())) {
      await form.getByRole("button", { name: "Send answer" }).click();
    }
    await expect(confirmation).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  await confirmation.getByRole("button", { name: "Confirm" }).click();
  await expect(confirmation).toBeHidden();
  await expect(decisionsOn(desk)).toHaveCount(0, live);
  await watch(starter, asked);
  await expect(watchedStatus(starter)).toHaveText("completed", live);
  // Its answer given, the reviewer's page goes on: their form of it
  // leaves with the decision, never failing the page.
  await expect(desk.getByRole("alert")).toHaveCount(0);
  await expect(desk.getByRole("heading", { name: "Follow-ups" })).toBeVisible();

  // Nothing asks the reviewer of the ended run any more: watched again,
  // it reads as no run, never showing what it returned.
  await watch(desk, asked);
  await expect(watchedStatus(desk)).toHaveText("unavailable", live);
  await expect(desk.getByRole("alert")).toHaveCount(0);
  await expect(decisionsOn(other)).toHaveCount(1);
});
