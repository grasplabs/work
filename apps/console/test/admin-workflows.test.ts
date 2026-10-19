import { adminViewOf } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

// The admin's own sample organizations, as the model's tests count them:
// core sends no drawn work yet, so only they have work to list.
import { SAMPLE_ORGS } from "../../../packages/shared/test/admin/fixtures/admin-sample.ts";
import { OrgWorkflows } from "../src/admin/workflows.tsx";
import { act, consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-workflows-5c2a19";
const tenantToken = "test-tenant-admin-token-admin-workflows-71e4b0";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): workflows" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(`Acme ${clientId}`);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, release.id)
  );
  return { clientId, account };
};

const { 0: noordkade, 3: hartog } = SAMPLE_ORGS;
const day = "2026-10-02";

/** The section as it renders for `view`. */
const sectionOf = (view: AdminView): string =>
  renderToString(createElement(OrgWorkflows, { view }));

/** The table's row of the work named `name`. */
const rowOf = (html: string, name: string): string => {
  const at = html.indexOf(`title="${name}"`);
  return at === -1
    ? ""
    : html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
};

/** The text of `html`, without its tags or what is there only for assistive technology. */
const textOf = (html: string): string =>
  html
    .replaceAll(/<span role="presentation"[^>]*>[^<]*<\/span>/gu, " ")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("an organization's workflows", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("says the work isn't known yet while the company's own Grasp doesn't draw it", async () => {
    const acme = await liveClient();
    acme.account.admin = { ...emptyAdminSnapshot("Acme"), told: true };

    const { status, html } = await page(
      `/admin/organizations/${acme.clientId}/workflows`
    );

    expect({
      status,
      title: html.includes("Workflows</h1>"),
      none: html.includes(
        "Not known yet: the company’s own Grasp doesn’t draw the work from its interviews yet."
      ),
      toCome: html.includes("This section isn’t in the console yet."),
      table: html.includes("<table"),
    }).toStrictEqual({
      status: 200,
      title: true,
      none: true,
      toCome: false,
      table: false,
    });
  });

  it("lists every piece of work with how far it is known, who talked, the steps described and what is still missing", () => {
    const view = adminViewOf(noordkade, noordkade.seed, day);
    const html = sectionOf(view);
    const papers = view.works.find((work) => work.id === "papers");
    const intake = view.works.find((work) => work.id === "intake");
    if (!(papers && intake)) {
      throw new Error("Noordkade's sample lacks its work");
    }
    const team = (id: string) =>
      view.teams.find((each) => each.team.id === id)?.team.name ?? "";

    expect({
      figures: [
        "workflows known 5 of 20",
        "still being mapped 15",
        "things still missing 32",
      ].map((text) => textOf(html).includes(text)),
      rows: (html.match(/<tr/gu) ?? []).length,
      papers: textOf(rowOf(html, papers.work.name)),
      intake: textOf(rowOf(html, intake.work.name)),
      teams: html.includes('aria-label="Team"'),
      rules: html.includes("When one counts as known"),
    }).toStrictEqual({
      figures: [true, true, true],
      // The head's row and one for each piece of work.
      rows: 21,
      papers: `${papers.work.name} ${team(papers.team)} Known 6 of 13 5 of 5 1 thing missing Known`,
      intake: `${intake.work.name} ${team(intake.team)} Being mapped 2 of 5 2 of 5 5 things missing Being mapped`,
      teams: true,
      rules: true,
    });
  });

  it("marks work Grasp counted as known by hand, and nothing missing where everyone described it", () => {
    const view = adminViewOf(hartog, hartog.seed, day);
    const html = sectionOf(view);
    const returns = view.works.find((work) => work.id === "returns");
    const quotes = view.works.find((work) => work.id === "quotes");
    if (!(returns && quotes)) {
      throw new Error("Hartog's sample lacks its work");
    }

    expect({
      known: textOf(html).includes("workflows known 11 of 11"),
      returns: textOf(rowOf(html, returns.work.name)).includes(
        "Counted as known by Grasp"
      ),
      quotes: textOf(rowOf(html, quotes.work.name)).includes("Nothing missing"),
    }).toStrictEqual({ known: true, returns: true, quotes: true });
  });
});
