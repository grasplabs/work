/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// A decision of an independent workflow, answered from an App's screen
// end to end in a real browser (spec 10.7.2): the starter's screen starts
// a run of the bound workflow; the reviewer's screen lists the decision
// in its inbox (`queries.decisions`) and answers it through a decision
// form (`useForm` of the decision's value schema and an explicit approval,
// submitting `workflow.respond`). Grasp's own dialog, outside the frame,
// shows what would be recorded: cancelled, nothing is, and the draft
// stays; confirmed, the answer is recorded, the inbox empties without a
// refresh and the run goes on. What the host refuses, and every race of
// answers, are core's own tests (apps/core/test/screen-workflow-decisions.test.ts).

// A trace of every failing page, kept as the run's artifact.
test.use({ trace: "retain-on-failure" });

/** How long a run's change may take to reach a screen. */
const live = { timeout: 30_000 };

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A native value descriptor of an object of string fields named `names`. */
const stringsDescriptor = (names: readonly string[]) =>
  v.object(Object.fromEntries(names.map((name) => [name, v.string()])))
    .descriptor;

/**
 * A workflow asking `reviewer` for decision `contract`, as `approval`, in
 * its task `ask`, then greeting.
 */
const definitionOf = (name: string, contract: string, reviewer: string) =>
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
          params: {},
          bindings: { approval: { kind: "decision", contract } },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        ask: {
          call: "grasp.decision",
          with: {
            binding: "approval",
            recipients: [`person:${reviewer}`],
            prompt: "Greet them?",
            input: { who: "${ $workflow.input.who }" },
          },
        },
      },
      { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
    ],
  });

/**
 * The App: it declares the `followUp` workflow; its screen starts runs
 * of it, shows the latest one's status, and lists the decisions waiting
 * for the person, each answered through its own decision form.
 */
const appFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ requests: defineTable({ who: v.string() }) });
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { followUp } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: {},
  internalOperations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  uses: [followUp],
});
`,
  "screens/review.tsx": `import { v } from "@grasp-os/sdk";
import type { WorkflowDecisionInboxItem } from "@grasp-os/sdk";
import { useForm, useWorkflow } from "@grasp-os/sdk/react";
import { Form, FormError, SubmitButton, TextField } from "@grasp-os/ui/form";
import { workflows } from "#grasp";

const decision = workflows.followUp.decisions.approval;
const responseSchema = v.object({
  approved: v.boolean(),
  value: decision.valueSchema,
});

/** One waiting decision, answered through its own form, mounted per item. */
export function Review({
  item,
}: {
  item: WorkflowDecisionInboxItem<"approval", { comment: string }>;
}) {
  const workflow = useWorkflow(workflows.followUp, { runId: item.run.runId });
  const form = useForm(responseSchema, {
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
}
`,
  "screens/desk.tsx": `import { useQuery, useWorkflow } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { workflows } from "#grasp";
import { Review } from "./review.tsx";

export default function Desk() {
  const followUp = useWorkflow(workflows.followUp);
  const inbox = useQuery(workflows.followUp.queries.decisions, {
    pagination: {},
  });
  return (
    <main>
      <h1>Follow-ups</h1>
      <output aria-label="Status">{followUp.status}</output>
      <Button onClick={() => void followUp.run({ who: "Ada" })}>
        Start follow-up
      </Button>
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
}
`,
});

/**
 * A new App of `appFiles` whose `followUp` binds version 1 of a new
 * workflow of `builder`'s asking `admin` alone, its decision binding
 * approved for them, released, published and current, its screens'
 * code approved and its `start` grant given by `admin`. Bound before the
 * release, so the screens' `workflows.followUp` names the decision.
 */
const boundApp = async (builder: Person, admin: Person): Promise<string> => {
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
    const workflow = await builds.api.workflowResources.create(
      `greet-${crypto.randomUUID().slice(0, 8)}`
    );
    await builds.api.workflowResources.publish(workflow.id, {
      definition: definitionOf(workflow.name, key, admin.userId),
      basedOn: null,
    });
    await decides.api.workflowResources.approveBinding(workflow.id, {
      alias: "approval",
      target: { kind: "decision", deciders: [`person:${admin.userId}`] },
      reviewed: { version: 1 },
    });
    await builds.api.workflowResources.bindToApp(workflow.id, {
      app,
      alias: "followUp",
      version: 1,
    });
    const { version } = await builds.api.apps.files.commit(
      app,
      appFiles(),
      "Requests"
    );
    await builds.api.apps.versions.setCurrent(app, version);
    await builds.api.apps.publish(app);
    const review = await decides.api.screenTrust.review(app);
    await decides.api.screenTrust.approve(app, {
      version: review.version,
      generation: review.generation,
      artifacts: builtArtifacts(review.screens),
    });
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
 * Opens the desk screen, once it shows. The first open of an App's
 * screen builds it, which on a loaded machine takes longer than the
 * default 5 seconds.
 */
const openDesk = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/domains/${app}/apps/desk/full`);
  const screen = page.frameLocator('iframe[title="desk app"]');
  await expect(screen.getByRole("heading", { name: "Follow-ups" })).toBeVisible(
    { timeout: 20_000 }
  );
  return screen;
};

const decisionsOn = (screen: FrameLocator) =>
  screen.getByRole("list", { name: "Decisions" }).getByRole("listitem");

test("a reviewer answers a run's decision through a decision form on a screen, confirmed in Grasp's own dialog, and a cancelled one records nothing", async ({
  pageOf,
}) => {
  const { builder, admin } = peopleIn("screenDecisionForm");
  const app = await boundApp(builder, admin);
  const [first, second] = await Promise.all([pageOf(builder), pageOf(admin)]);
  const [starter, reviewer] = await Promise.all([
    openDesk(first, app),
    openDesk(second, app),
  ]);

  // The starter starts a run; it waits for its decision, which only the
  // reviewer's inbox lists, without a refresh.
  await starter.getByRole("button", { name: "Start follow-up" }).click();
  await expect(starter.getByRole("status", { name: "Status" })).toHaveText(
    "running",
    live
  );
  await expect(decisionsOn(reviewer)).toHaveCount(1, live);
  await expect(decisionsOn(starter)).toHaveCount(0);

  // The reviewer chooses to approve and writes a comment: nothing is sent
  // until they submit, and then Grasp's own dialog, outside the frame,
  // shows what would be recorded. Cancelled, nothing is: the decision
  // still waits, and the draft is still there to send.
  const form = decisionsOn(reviewer).first();
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
  await expect(decisionsOn(reviewer)).toHaveCount(1);
  await expect(form.getByRole("textbox", { name: "Comment" })).toHaveValue(
    "Looks right"
  );
  await expect(form.getByRole("radio", { name: "Approve" })).toBeChecked();

  // Sent again (the page holds a cancelled answer back a while, so the
  // screen can't keep the reviewer behind its dialog) and confirmed: the
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
  await expect(decisionsOn(reviewer)).toHaveCount(0, live);
  await expect(starter.getByRole("status", { name: "Status" })).toHaveText(
    "completed",
    live
  );
});
