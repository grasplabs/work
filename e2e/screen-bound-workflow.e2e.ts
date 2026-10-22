/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { expect } from "@playwright/test";
import type { FrameLocator, Page, Route } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// A screen's typed `useWorkflow` on a workflow its App binds (spec 10.4),
// end to end in a real browser: the screen starts a run of the bound
// independent workflow, sees it run, and cancels it, with what it may do
// (`canCancel`) and the control still settling (`pendingControl`) as they
// change; and a page loaded again while a start is under way never starts
// the run a second time. What the host refuses, and every race of its
// receipts, are core's own tests (apps/core/test/screen-typed-workflows.test.ts).

// A trace of every failing page, kept as the run's artifact.
test.use({ trace: "retain-on-failure" });

/** How long a run's change may take to reach the screen. */
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

/**
 * A workflow that holds for an hour, then greets: a run stays running
 * until someone cancels it.
 */
const definitionOf = (name: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      { hold: { wait: "PT1H" } },
      { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
    ],
  });

/**
 * The App: it declares the `followUp` workflow, and its screen drives the
 * bound one through `useWorkflow(workflows.followUp)`, showing each of the
 * hook's fields it reads.
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
  "screens/desk.tsx": `import { useWorkflow } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { workflows } from "#grasp";

const yesNo = (value: boolean): string => (value ? "yes" : "no");

export default function Desk() {
  const followUp = useWorkflow(workflows.followUp);
  const [refused, setRefused] = useState("");
  const tried = async (command: () => Promise<unknown>): Promise<void> => {
    try {
      await command();
    } catch (error) {
      setRefused(error instanceof Error ? error.message : "Refused");
    }
  };
  const pending =
    followUp.pendingControl === null
      ? "none"
      : \`\${followUp.pendingControl.kind} \${followUp.pendingControl.stage}\`;
  return (
    <main>
      <h1>Follow-ups</h1>
      <output aria-label="Status">{followUp.status}</output>
      <output aria-label="Can run">{yesNo(followUp.canRun)}</output>
      <output aria-label="Starting">{yesNo(followUp.isStarting)}</output>
      <output aria-label="Can cancel">{yesNo(followUp.canCancel)}</output>
      <output aria-label="Pending control">{pending}</output>
      <Button onClick={() => tried(() => followUp.run({ who: "Ada" }))}>
        Start follow-up
      </Button>
      <Button onClick={() => tried(followUp.cancel)}>Cancel follow-up</Button>
      {refused === "" ? null : <p role="alert">{refused}</p>}
    </main>
  );
}
`,
});

/**
 * A new App of `appFiles` whose `followUp` binds version 1 of a new
 * holding workflow of `builder`'s, released and current, its screen's
 * code approved and the App's `start` grant given by `admin`. Bound
 * before the release, so the screen's `workflows.followUp` is generated
 * from the binding.
 */
const boundApp = async (
  builder: Person,
  admin: Person
): Promise<{ app: string; workflow: string }> => {
  const builds = apiOf(builder);
  const decides = apiOf(admin);
  try {
    const { id: app } = await builds.api.apps.create({
      name: `Requests ${crypto.randomUUID().slice(0, 8)}`,
    });
    const workflow = await builds.api.workflowResources.create(
      `follow-up-${crypto.randomUUID().slice(0, 8)}`
    );
    await builds.api.workflowResources.publish(workflow.id, {
      definition: definitionOf(workflow.name),
      basedOn: null,
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
    return { app, workflow: workflow.id };
  } finally {
    builds.core[Symbol.dispose]();
    decides.core[Symbol.dispose]();
  }
};

/** How many runs workflow `id` has, as its builder sees them. */
const runsOf = async (builder: Person, id: string): Promise<number> => {
  const { core, api } = apiOf(builder);
  try {
    const runs = await api.workflowResources.runs(id);
    return runs.length;
  } finally {
    core[Symbol.dispose]();
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

/** One of the screen's fields, as the hook shows it. */
const field = (screen: FrameLocator, name: string) =>
  screen.getByRole("status", { name, exact: true });

/** Whether `route` relays the screen's workflow command `command`. */
const relays = (route: Route, command: "start" | "cancel"): boolean =>
  route.request().method() === "POST" &&
  (route.request().postData() ?? "").includes(`"command":"${command}"`);

test("a screen starts and cancels a bound workflow's run, and a reload during a start doesn't start it twice", async ({
  pageOf,
}) => {
  const { builder, admin } = peopleIn("screenBoundWorkflow");
  const { app, workflow } = await boundApp(builder, admin);
  const page = await pageOf(builder);
  const screen = await openDesk(page, app);

  // Nothing runs until asked; the binding and the grant let them start one.
  await expect(field(screen, "Status")).toHaveText("idle");
  await expect(field(screen, "Can run")).toHaveText("yes", live);
  await expect(field(screen, "Can cancel")).toHaveText("no");

  // Started, the run shows running, and may be cancelled.
  await screen.getByRole("button", { name: "Start follow-up" }).click();
  await expect(field(screen, "Status")).toHaveText("running", live);
  await expect(field(screen, "Starting")).toHaveText("no");
  await expect(field(screen, "Can cancel")).toHaveText("yes", live);
  await expect(field(screen, "Pending control")).toHaveText("none");
  expect(await runsOf(builder, workflow)).toBe(1);

  // The cancel held on its way to core: it shows as submitting, and the
  // run can't be cancelled again meanwhile.
  const cancelHeld = Promise.withResolvers<null>();
  const sendCancel = Promise.withResolvers<null>();
  await page.route("**/api/app-functions/**", async (route) => {
    if (!relays(route, "cancel")) {
      await route.fallback();
      return;
    }
    cancelHeld.resolve(null);
    await sendCancel.promise;
    await route.continue();
  });
  await screen.getByRole("button", { name: "Cancel follow-up" }).click();
  await cancelHeld.promise;
  await expect(field(screen, "Pending control")).toHaveText(
    "cancel submitting"
  );
  await expect(field(screen, "Can cancel")).toHaveText("no");
  await expect(field(screen, "Status")).toHaveText("running");

  // Let through, the run is cancelled, and nothing is left to settle or ask.
  sendCancel.resolve(null);
  await expect(field(screen, "Status")).toHaveText("cancelled", live);
  await expect(field(screen, "Pending control")).toHaveText("none", live);
  await expect(field(screen, "Can cancel")).toHaveText("no");
  await page.unrouteAll({ behavior: "wait" });

  // A start that reached core, with the page loaded again before its
  // answer came back: core admitted one run, and the page loaded again
  // starts nothing, now or as it follows the workflow again.
  const admitted = Promise.withResolvers<Route>();
  await page.route("**/api/app-functions/**", async (route) => {
    if (!relays(route, "start")) {
      await route.fallback();
      return;
    }
    await route.fetch();
    admitted.resolve(route);
  });
  await screen.getByRole("button", { name: "Start follow-up" }).click();
  await expect(field(screen, "Starting")).toHaveText("yes");
  const lost = await admitted.promise;
  await page.reload();
  await lost.abort().catch(() => {
    // The page it answered is gone already.
  });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const reloaded = page.frameLocator('iframe[title="desk app"]');
  await expect(
    reloaded.getByRole("heading", { name: "Follow-ups" })
  ).toBeVisible({ timeout: 20_000 });
  // Following the workflow again, it shows no run and starts none: the
  // cancelled run and the one core admitted are all there is.
  await expect(field(reloaded, "Can run")).toHaveText("yes", live);
  await expect(field(reloaded, "Status")).toHaveText("idle");
  await expect(field(reloaded, "Starting")).toHaveText("no");
  expect(await runsOf(builder, workflow)).toBe(2);
  // Given the time a resent start would take to land, still those two.
  await page.waitForTimeout(3000);
  expect(await runsOf(builder, workflow)).toBe(2);
});
