import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { teamItemsOf, WorkflowTeamView } from "./team-picker.tsx";
import type { TeamChoice } from "./team-picker.tsx";

// The team that owns a workflow, on its page: a select for those who may
// change it, in words for everyone else.

const finance = { id: "team-finance", name: "Finance" };
const sales = { id: "team-sales", name: "Sales" };
const ops = { id: "team-ops", name: "Operations" };

/** The view's text, as a person reads it: tags gone, spaces collapsed. */
const textOf = (team: TeamChoice | null, editable: boolean): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <WorkflowTeamView
        editable={editable}
        team={team}
        teams={null}
        onOpen={() => {}}
        onPick={() => {}}
      />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

/** What the select's items say. */
const labels = (items: { label: string }[]) => items.map(({ label }) => label);

describe("a workflow's team", () => {
  it("reads as words for those who may not change it, and as the select's value for those who may", () => {
    expect({
      readOnly: textOf(finance, false),
      readOnlyNone: textOf(null, false),
      editable: textOf(finance, true),
      editableNone: textOf(null, true),
    }).toStrictEqual({
      readOnly: "Team: Finance",
      readOnlyNone: "No team",
      // The select shows its value, then its arrow.
      editable: "Finance ▼",
      editableNone: "No team ▼",
    });
  });

  it("offers none and the organization's teams by name, and the team it has before they are read", () => {
    expect({
      unread: labels(teamItemsOf(finance, null, "No team")),
      unreadNone: labels(teamItemsOf(null, null, "No team")),
      read: labels(teamItemsOf(finance, [sales, finance, ops], "No team")),
      values: teamItemsOf(null, [finance], "No team").map(({ value }) => value),
    }).toStrictEqual({
      unread: ["No team", "Finance"],
      unreadNone: ["No team"],
      read: ["No team", "Finance", "Operations", "Sales"],
      values: ["", "team-finance"],
    });
  });
});
