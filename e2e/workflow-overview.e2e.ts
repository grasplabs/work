import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// A builder's Workflows: every workflow they have a role in, one row each
// in one table, saying how it stands now (a live one on, one with no
// version yet not live); their runs a page of their own, Workflows › Runs,
// filtered by status in the address; and a workflow's page with its runs,
// each opening a page of its own, which its address keeps across a reload.

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

test("a builder finds their workflows in one table, their runs on a page of their own filtered in the address, and a run on a page of its own", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowOverview");
  const live = await made(builder, "Invoice approval", waiting("1 hour"), true);
  await made(builder, "Contract review", waiting("1 second"), false);
  const page = await pageOf(builder);

  // Each workflow a row, saying how it stands now: one table where the
  // window is wide enough for its columns.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/workflows");
  const table = page.getByRole("table", { name: "Workflows" });
  const row = (name: string) =>
    table.getByRole("row").filter({
      has: page.getByRole("link", { name, exact: true }),
    });
  await expect(row("Invoice approval")).toContainText("On", pageRead);
  await expect(row("Contract review")).toContainText("Not live yet");

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

  // The workflow's page lists its runs; one opens on a page of its own,
  // which its address keeps.
  await page.goto(`/workflows/${live}`);
  await page
    .getByRole("link", { name: /^Run of/u })
    .first()
    .click(pageRead);
  await expect(page).toHaveURL(
    new RegExp(`/workflows/${live}/runs/[^/?]+$`, "u")
  );
  const title = page.getByRole("heading", { level: 1, name: /^Run of/u });
  await expect(title).toBeVisible(pageRead);
  await page.reload();
  await expect(title).toBeVisible(pageRead);
});
