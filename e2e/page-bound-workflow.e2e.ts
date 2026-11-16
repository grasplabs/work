import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { expect } from "@playwright/test";
import type { FrameLocator, Page, Route } from "@playwright/test";

import { boundIn, testApp } from "../apps/core/test/app-definitions.ts";
import type { TestApp } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// A page's typed `useWorkflow` on a workflow its App binds (spec 10.4),
// end to end in a real browser: the page starts a run of the bound
// independent workflow, sees it run, and cancels it, with what it may do
// (`canCancel`) and the control still settling (`pendingControl`) as they
// change; and a page loaded again while a start is under way never starts
// the run a second time. What the host refuses, and every race of its
// receipts, are core's own tests (apps/core/test/page-typed-workflows.test.ts).

// A trace of every failing page, kept as the run's artifact.
test.use({ trace: "retain-on-failure" });

/** How long a run's change may take to reach the page. */
const live = { timeout: 30_000 };

/** A value's schema: an object of exactly `fields`, each required. */
const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/**
 * A workflow that holds for an hour, then greets: a run stays running
 * until someone cancels it.
 */
const definition = JSON.stringify({
  $schema: workflowSchemaUrl,
  args: objectSchema({ who: { kind: "string" } }),
  returns: objectSchema({ status: { kind: "string" } }),
  result: { status: { $expr: '"Hello, " + args.who' } },
  steps: [{ id: "hold", type: "wait", for: "1 hour" }],
});

/**
 * The App: it declares the `followUp` workflow, and its page drives the
 * bound one through `useWorkflow(workflows.followUp)`, showing each of the
 * hook's fields it reads.
 */
const appFiles = (): TestApp =>
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
        'permission.workflow("followUp", {\n  args: v.object({ who: v.string().trim().min(1) }),\n  returns: v.object({ status: v.string() }),\n})',
      ],
    },
    {
      "server/requests.ts": `import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;
`,

      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useWorkflow } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { workflows } from "@server/_generated/api";

const yesNo = (value: boolean): string => (value ? "yes" : "no");

const Desk = () => {
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
      <output aria-label="Can start">{yesNo(followUp.canStart)}</output>
      <output aria-label="Starting">{yesNo(followUp.isStarting)}</output>
      <output aria-label="Can cancel">{yesNo(followUp.canCancel)}</output>
      <output aria-label="Pending control">{pending}</output>
      <Button onClick={() => tried(() => followUp.start({ who: "Ada" }))}>
        Start follow-up
      </Button>
      <Button onClick={() => tried(followUp.cancel)}>Cancel follow-up</Button>
      {refused === "" ? null : <p role="alert">{refused}</p>}
    </main>
  );
};
export const Route = createFileRoute("/")({ component: Desk });
`,
    }
  );

/**
 * A new App of `appFiles` whose `followUp` binds version 1 of a new
 * holding workflow of `builder`'s, released and live, the App's
 * `start` grant given by `admin`. Bound
 * before the release, so the page's `workflows.followUp` is generated
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
    // A new workflow's draft is at revision 0: written, then published.
    await builds.api.drafts.write({ kind: "workflow", id: workflow.id }, 0, {
      "workflow.json": definition,
    });
    await builds.api.drafts.publish({ kind: "workflow", id: workflow.id }, 1);
    // Published from its draft, binding the workflow as it goes live.
    await release(
      builds.api,
      app,
      boundIn(appFiles(), { followUp: workflow.id })
    );
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

/** One of the page's fields, as the hook shows it. */
const field = (appPage: FrameLocator, name: string) =>
  appPage.getByRole("status", { name, exact: true });

/** Whether `route` relays the page's call of the workflow's mutation `name`. */
const relays = (route: Route, name: "start" | "cancel"): boolean =>
  route.request().method() === "POST" &&
  (route.request().postData() ?? "").includes(`.mutations.${name}"`);

test("a page starts and cancels a bound workflow's run, and a reload during a start doesn't start it twice", async ({
  pageOf,
}) => {
  const { builder, admin } = peopleIn("pageBoundWorkflow");
  const { app, workflow } = await boundApp(builder, admin);
  const page = await pageOf(builder);
  const appPage = await openDesk(page, app);

  // Nothing runs until asked; the binding and the grant let them start one.
  await expect(field(appPage, "Status")).toHaveText("idle");
  await expect(field(appPage, "Can start")).toHaveText("yes", live);
  await expect(field(appPage, "Can cancel")).toHaveText("no");

  // Started, the run shows running, and may be cancelled.
  await appPage.getByRole("button", { name: "Start follow-up" }).click();
  await expect(field(appPage, "Status")).toHaveText("running", live);
  await expect(field(appPage, "Starting")).toHaveText("no");
  await expect(field(appPage, "Can cancel")).toHaveText("yes", live);
  await expect(field(appPage, "Pending control")).toHaveText("none");
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
  await appPage.getByRole("button", { name: "Cancel follow-up" }).click();
  await cancelHeld.promise;
  await expect(field(appPage, "Pending control")).toHaveText(
    "cancel submitting"
  );
  await expect(field(appPage, "Can cancel")).toHaveText("no");
  await expect(field(appPage, "Status")).toHaveText("running");

  // Let through, the run is cancelled, and nothing is left to settle or ask.
  sendCancel.resolve(null);
  await expect(field(appPage, "Status")).toHaveText("cancelled", live);
  await expect(field(appPage, "Pending control")).toHaveText("none", live);
  await expect(field(appPage, "Can cancel")).toHaveText("no");
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
  await appPage.getByRole("button", { name: "Start follow-up" }).click();
  await expect(field(appPage, "Starting")).toHaveText("yes");
  const lost = await admitted.promise;
  await page.reload();
  await lost.abort().catch(() => {
    // The page it answered is gone already.
  });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const reloaded = page.frameLocator('iframe[title="App"]');
  await expect(
    reloaded.getByRole("heading", { name: "Follow-ups" })
  ).toBeVisible({ timeout: 20_000 });
  // Following the workflow again, it shows no run and starts none: the
  // cancelled run and the one core admitted are all there is.
  await expect(field(reloaded, "Can start")).toHaveText("yes", live);
  await expect(field(reloaded, "Status")).toHaveText("idle");
  await expect(field(reloaded, "Starting")).toHaveText("no");
  expect(await runsOf(builder, workflow)).toBe(2);
  // Given the time a resent start would take to land, still those two.
  await page.waitForTimeout(3000);
  expect(await runsOf(builder, workflow)).toBe(2);
});
