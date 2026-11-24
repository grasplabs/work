import { adminOrgOf } from "@grasp-os/shared/admin/admin-snapshot-adapter";
import { adminViewOf } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// A small company as core answers for it, with Sales's orders drawn from its
// interviews: core sends the admin no drawn work yet.
import {
  bothTalked,
  client,
  orders,
} from "../../../packages/shared/test/admin/fixtures/bakkerij.ts";
import { OrgWorkflows } from "../src/admin/workflows.tsx";

const day = "2026-10-14";

/** Bakkerij with its orders drawn, and what Grasp counted as known by hand. */
const drawnView = (counted: string[], work = orders): AdminView => {
  const { org, state } = adminOrgOf(
    {
      ...bothTalked,
      works: { works: [work], rules: STARTING_ORG_RULES, counted },
    },
    client
  );
  return adminViewOf(org, state, day);
};

/** The section as it renders for `view`. */
const sectionOf = (view: AdminView): string =>
  renderToString(createElement(OrgWorkflows, { view, clientId: "client" }));

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
  it("lists every piece of work with how far it is known, who talked, the steps described and what is still missing", () => {
    const view = drawnView([]);
    const html = sectionOf(view);
    const team = (id: string) =>
      view.teams.find((each) => each.team.id === id)?.team.name ?? "";

    expect({
      rows: (html.match(/<tr/gu) ?? []).length,
      orders: textOf(rowOf(html, orders.name)),
      // What Grasp can do for it is behind its row's menu.
      menu: html.includes(`aria-label="What Grasp can do for ${orders.name}"`),
      filters: ['aria-label="How far it is"', 'aria-label="Team"'].filter(
        (text) => html.includes(text)
      ),
      rules: html.includes("When one counts as known"),
    }).toStrictEqual({
      // The head's row and one for the piece of work.
      rows: 2,
      orders: `${orders.name} ${team(orders.team)} Being mapped 2 of 3 0 of 2 5 things missing Being mapped`,
      menu: true,
      // One workflow is read whole: nothing to narrow the list with.
      filters: [],
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
      byHand: textOf(rowOf(html, orders.name)).includes(
        "Counted as known by Grasp"
      ),
      nothing: textOf(rowOf(everyone, orders.name)).includes("Nothing missing"),
    }).toStrictEqual({ byHand: true, nothing: true });
  });
});
