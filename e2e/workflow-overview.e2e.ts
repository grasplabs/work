import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// A builder's Workflows: every workflow they have a role in, one row each,
// gathered by the phase it stands in (a live one running, one with no
// version yet building); its runs a page of their own, Workflows › Runs,
// filtered by status in the address; and a run opened beside a workflow's
// runs, which its address keeps open across a reload. An address the
// pages don't know (a status, a view, a run the person can't open) opens
// the page as it is without it.

/** How long a read from core may take to show. */
const pageRead = { timeout: 15_000 };

/** A definition that waits `wait`, then answers. */
const waiting = (wait: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: { kind: "object", fields: {} },
    returns: { kind: "object", fields: { status: { kind: "string" } } },
    result: { status: "done" },
    steps: [{ id: "hold", type: "wait", for: wait }],
  });

/** Makes a workflow named `title`, its draft `text`, published when `live`. */
const made = async (
  person: Person,
  title: string,
  text: string,
  live: boolean
): Promise<string> => {
  const { core, api } = apiOf(person);
  try {
    const name = `overview-${crypto.randomUUID().slice(0, 8)}`;
    const { id } = await api.workflowResources.create(name, undefined, title);
    const subject = { kind: "workflow", id } as const;
    const draft = await api.drafts.write(subject, 0, { "workflow.json": text });
    if (live) {
      await api.drafts.publish(subject, draft.revision);
      await api.workflowResources.start(id, {
        args: {},
        key: crypto.randomUUID(),
      });
    }
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

test("a builder finds their workflows by phase, their runs on a page of their own filtered in the address, and a run kept open by its address", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowOverview");
  const live = await made(builder, "Invoice approval", waiting("1 hour"), true);
  await made(builder, "Contract review", waiting("1 second"), false);
  const page = await pageOf(builder);

  // Each workflow under its phase, saying how it stands.
  await page.goto("/workflows");
  const running = page.getByRole("region", { name: "Running" });
  await expect(
    running.getByRole("link", { name: "Invoice approval" })
  ).toBeVisible(pageRead);
  const building = page.getByRole("region", { name: "Building" });
  await expect(
    building.getByRole("link", { name: "Contract review" })
  ).toBeVisible();
  await expect(building).toContainText("Not live yet");

  // Its runs, a page of their own, filtered by status in the address.
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\/runs$/u);
  const log = page.getByRole("table", { name: "Runs" });
  await expect(log.getByRole("row").nth(1)).toContainText("Running", pageRead);
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Failed" }).click();
  await expect(page).toHaveURL(/\/workflows\/runs\?status=failed$/u);
  await expect(page.getByText("No runs match these filters.")).toBeVisible(
    pageRead
  );

  // A run opened beside the workflow's runs: its address keeps it open.
  await page.goto(`/workflows/${live}?view=runs`);
  await page
    .getByRole("table", { name: "Runs" })
    .getByRole("link")
    .first()
    .click(pageRead);
  await expect(page).toHaveURL(/[?&]run=/u);
  const opened = page.getByRole("complementary", {
    name: /^The run started/u,
  });
  await expect(opened).toBeVisible(pageRead);
  await page.reload();
  await expect(opened).toBeVisible(pageRead);
});

test("an address the workflows pages don't know opens them as they are without it, and a run closed stays closed on Back", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowOverview");
  const live = await made(builder, "Quote approval", waiting("1 hour"), true);
  const page = await pageOf(builder);

  // A status the log doesn't filter by: the page, unfiltered, its lanes by
  // the workflows' titles, as Workflows names them.
  await page.goto("/workflows/runs?status=nonsense");
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveText(
    "All",
    pageRead
  );
  await expect(
    page
      .getByRole("region", { name: "Today" })
      .getByRole("link", { name: "Quote approval" })
      .first()
  ).toBeAttached(pageRead);

  // A view the workflow's page doesn't have: its first view, for a builder Flow.
  await page.goto(`/workflows/${live}?view=bogus`);
  await expect(
    page
      .getByRole("navigation", { name: "Workflow views" })
      .locator('[aria-current="page"]')
  ).toHaveText("Flow", pageRead);

  // A run it doesn't list: one sentence, whatever the reason, and the
  // address lets it go.
  await page.goto(`/workflows/${live}?view=runs&run=not-a-run`);
  await expect(
    page.getByText("That run wasn't found, or isn't yours to see.")
  ).toBeVisible(pageRead);
  await expect(page).not.toHaveURL(/[?&]run=/u);

  // Opened and closed, Back goes where the person was before, never to the
  // run again.
  await page.goto("/workflows");
  await page.goto(`/workflows/${live}?view=runs`);
  await page
    .getByRole("table", { name: "Runs" })
    .getByRole("link")
    .first()
    .click(pageRead);
  const opened = page.getByRole("complementary", {
    name: /^The run started/u,
  });
  await expect(opened).toBeVisible(pageRead);
  await opened.getByRole("button", { name: "Close" }).click();
  await expect(page).not.toHaveURL(/[?&]run=/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/workflows$/u);
});
