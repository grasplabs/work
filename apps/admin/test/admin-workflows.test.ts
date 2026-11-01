import { adminOrgOf } from "@grasp-os/shared/admin/admin-snapshot-adapter";
import { adminViewOf } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

// A small company as core answers for it, with Sales's orders drawn from its
// interviews: core sends the admin no drawn work yet.
import {
  bothTalked,
  client,
  orders,
} from "../../../packages/shared/test/admin/fixtures/bakkerij.ts";
import { OrgWorkflows } from "../src/admin/workflows.tsx";
import { adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-workflows-5c2a19";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): workflows");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name: `Acme ${clientId}`,
    signIn: null,
  });
  return { clientId, account };
};

const day = "2026-10-14";

/** Bakkerij with its orders drawn, and what Grasp counted as known by hand. */
const drawnView = (counted: string[], work = orders): AdminView => {
  const { org, state } = adminOrgOf(bothTalked, client, {
    works: [work],
    rules: STARTING_ORG_RULES,
    counted,
  });
  return adminViewOf(org, state, day);
};

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
  useStoreSecrets({ deployer: token });
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
      `/organizations/${acme.clientId}/workflows`
    );

    expect({
      status,
      title: html.includes("Workflows</h1>"),
      none: html.includes(
        "Not known yet: the company’s own Grasp doesn’t draw the work from its interviews yet."
      ),
      toCome: html.includes("This section isn’t in the admin yet."),
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
    const view = drawnView([]);
    const html = sectionOf(view);
    const team = (id: string) =>
      view.teams.find((each) => each.team.id === id)?.team.name ?? "";

    expect({
      figures: [
        "workflows known 0 of 1",
        "still being mapped 1",
        "things still missing 5",
      ].map((text) => textOf(html).includes(text)),
      rows: (html.match(/<tr/gu) ?? []).length,
      orders: textOf(rowOf(html, orders.name)),
      teams: html.includes('aria-label="Team"'),
      rules: html.includes("When one counts as known"),
    }).toStrictEqual({
      figures: [true, true, true],
      // The head's row and one for the piece of work.
      rows: 2,
      orders: `${orders.name} ${team(orders.team)} Being mapped 2 of 3 0 of 2 5 things missing Being mapped`,
      // Its work is all one team's: no column to tell teams apart.
      teams: false,
      rules: true,
    });
  });

  it("marks work Grasp counted as known by hand, and nothing missing where everyone described it", () => {
    const html = sectionOf(drawnView(["orders"]));
    const everyone = sectionOf(
      drawnView([], {
        ...orders,
        doers: ["lisa", "tom"],
        drawn: orders.drawn && {
          ...orders.drawn,
          starts: "A shop calls.",
          right: "The bakery has the order.",
          next: "The bakery.",
          // Both said what right looks like and who gets it next.
          told: Object.fromEntries(
            Object.entries(orders.drawn.told).map(([person, told]) => [
              person,
              { ...told, right: true, next: true },
            ])
          ),
          open: [],
        },
      })
    );

    expect({
      known: textOf(html).includes("workflows known 1 of 1"),
      byHand: textOf(rowOf(html, orders.name)).includes(
        "Counted as known by Grasp"
      ),
      nothing: textOf(rowOf(everyone, orders.name)).includes("Nothing missing"),
    }).toStrictEqual({ known: true, byHand: true, nothing: true });
  });
});
