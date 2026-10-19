import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

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

const token = "test-deployer-token-admin-details-5c1a90";
const tenantToken = "test-tenant-admin-token-admin-details-e27b43";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): the details" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Acme ${clientId}`;
  const account = cloudflare.addAccount(name);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name,
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

/** A company with its list of people in: three people in two teams. */
const listedSnapshot = (name: string): AdminSnapshot => ({
  ...emptyAdminSnapshot(name),
  roster: {
    teams: [
      { id: "finance", name: "Finance", lead: "eva", does: "", off: false },
      { id: "sales", name: "Sales", lead: null, does: "", off: false },
    ],
    people: [
      {
        id: "eva",
        name: "Eva Bakker",
        email: "eva@noordkade.test",
        team: "finance",
        title: "CFO",
        away: false,
      },
      {
        id: "ruben",
        name: "Ruben de Vries",
        email: "ruben@noordkade.test",
        team: "finance",
        title: "",
        away: false,
      },
      {
        id: "lotte",
        name: "Lotte Jansen",
        email: "lotte@noordkade.test",
        team: "sales",
        title: "",
        away: false,
      },
    ],
  },
});

/** The page's main part, past the column of sections. */
const mainOf = (html: string): string => html.slice(html.indexOf("<main"));

/** What the papers say for `label`: the text of the line under it. */
const paperOf = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}</dt>`);
  if (at === -1) {
    return "";
  }
  const start = html.indexOf("<dd", at);
  const end = html.indexOf("</dd>", start);
  return html
    .slice(html.indexOf(">", start) + 1, end)
    .replaceAll(/<[^>]*>/gu, "");
};

describe("an organization's details", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });

  it("shows the company as core has it, its people counted, and every part core doesn't hold as not known yet", async () => {
    const acme = await liveClient();
    acme.account.admin = listedSnapshot("Noordkade");

    const { status, html } = await page(
      `/admin/organizations/${acme.clientId}/details`
    );
    const main = mainOf(html);

    expect({
      status,
      title: main.includes("Details</h1>"),
      toCome: main.includes("This section isn’t in the console yet."),
      name: main.includes(">Noordkade</h2>"),
      about: main.includes("What it does is not known yet"),
      people: main.includes("3 people in 2 teams"),
      // Core holds no website, so there is nothing to open.
      website: main.includes("in a new tab"),
      // Nobody is known for any part, so each says what it is for.
      contacts: [
        "Wants this to happen, and decides.",
        "Runs the company’s own onboarding and its workspace.",
        "Gets the invoices.",
        "Answers for how the company handles personal data.",
      ].map((what) => main.includes(what)),
      writes: main.includes("mailto:"),
      calls: main.includes("Once Attio is connected, this fills in by itself."),
      papers: [
        "Name on the contract",
        "Website",
        "Company register number",
        "VAT number",
        "Address",
      ].map((label) => paperOf(main, label)),
      // People of the company are counted, never named here.
      named: ["Eva Bakker", "Ruben de Vries", "Lotte Jansen"].some((person) =>
        main.includes(person)
      ),
    }).toStrictEqual({
      status: 200,
      title: true,
      toCome: false,
      name: true,
      about: true,
      people: true,
      website: false,
      contacts: [true, true, true, true],
      writes: false,
      calls: true,
      // Core holds no contract, so the name it stands under there isn't known.
      papers: [
        "Not known yet",
        "Not known yet",
        "Not known yet",
        "Not known yet",
        "Not known yet",
      ],
      named: false,
    });
  });

  it("says a company's people aren't known before its list is in", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Noordkade");

    const { html } = await page(
      `/admin/organizations/${acme.clientId}/details`
    );

    expect([
      html.includes("Its people are not known until its own list is in"),
      html.includes("people in"),
    ]).toStrictEqual([true, false]);
  });
});
