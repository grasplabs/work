// @vitest-environment happy-dom
import type { Source, Statement } from "@grasp-os/shared/brain";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { StatementsByKind } from "./brain-article/statements-by-kind.tsx";
import { statementWords } from "./brain.ts";

// What the Brain page says of what the interviews gave it (GRA-1084): a
// statement the onboarding gave is a team's claim of how it works
// (GRA-1987), and reads so, never as one person's words nor with how many
// told it; one an admin
// added reads as it always did.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const interviews: Source = {
  id: "onb-src-ops",
  kind: "interview",
  title: "Interviews with Ops",
  date: "2026-10-20",
  how: "7 people",
};

const statement = (id: string, text: string): Statement => ({
  id,
  kind: "tool",
  text,
  sourceId: interviews.id,
  teamIds: ["team-ops"],
  toolIds: [],
});

/** `node` on a page with the brain's note route, as the app has it. */
const shown = async (node: ReactElement): Promise<void> => {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => node,
  });
  const note = createRoute({
    getParentRoute: () => rootRoute,
    path: "/brain/$noteId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, note]),
    history: createMemoryHistory(),
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
};

/** Each statement's line on the page, and what is said under it. */
const lines = () =>
  [...document.querySelectorAll<HTMLElement>("[data-statement]")].map(
    (line) => ({
      id: line.dataset.statement,
      basis:
        line.textContent?.includes(
          "How the team works, as its people told it"
        ) ?? false,
    })
  );

/** What the page says on the line of statement `id`. */
const basisOf = (id: string) =>
  document.querySelector(`[data-statement="${id}"]`)?.textContent ?? "";

describe("what the Brain page says of the interviews", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("reads a team's claim as how the team works, and an admin's statement as it is", async () => {
    const claim = statement(
      "onb-st-0123456789abcdef0123456789abcdef",
      "Tickets come in through Zendesk."
    );
    const added = statement("st-zendesk", "Zendesk holds every ticket.");
    await shown(
      <StatementsByKind
        kern={{ interviewed: [], counts: [{ kind: "tool", count: 2 }] }}
        rows={[claim, added].map((each) => ({
          statement: each,
          place: { source: interviews, context: [], own: 0 },
        }))}
      />
    );
    expect(lines()).toStrictEqual([
      { id: claim.id, basis: true },
      { id: added.id, basis: false },
    ]);
  });

  it("reads an opinion of the company's as said by five or more people across the company, never quoted, with no team (GRA-1987)", async () => {
    const opinions: Source = {
      id: "onb-opinions",
      kind: "interview",
      title: "What people across the company say",
      date: "2026-11-17",
    };
    const opinion: Statement = {
      id: "onb-opinion-0123456789abcdef",
      kind: "timeSink",
      text: "Typing invoices in again by hand costs people a lot of time.",
      sourceId: opinions.id,
      teamIds: [],
      toolIds: [],
    };
    const claim: Statement = {
      ...statement("onb-claim-0123456789abcdef", "Tickets wait for days."),
      kind: "timeSink",
    };
    await shown(
      <StatementsByKind
        kern={{ interviewed: [], counts: [{ kind: "timeSink", count: 2 }] }}
        rows={[opinion, claim].map((each) => ({
          statement: each,
          place: {
            source: each === opinion ? opinions : interviews,
            context: [],
            own: 0,
          },
        }))}
      />
    );
    expect({
      opinion: basisOf(opinion.id).includes(
        "Said by five or more people across the company"
      ),
      claim: [
        basisOf(claim.id).includes("How the team works, as its people told it"),
        basisOf(claim.id).includes("across the company"),
      ],
      words: statementWords(opinion.id, opinion.text),
    }).toStrictEqual({
      opinion: true,
      claim: [true, false],
      words: opinion.text,
    });
  });

  it("offers an admin to remove their own statements, whatever they cite, and never a team's claim", async () => {
    const claim = statement(
      "onb-claim-0123456789abcdef",
      "Tickets come in through Zendesk."
    );
    // An admin's own record, from a source of theirs.
    const notes: Source = {
      id: "src-notes",
      kind: "document",
      title: "Notes",
      date: "2026-10-20",
      forgettable: true,
    };
    const added = {
      ...statement("st-zendesk", "Zendesk holds every ticket."),
      sourceId: notes.id,
    };
    // One of theirs citing the staff list, a source no admin removes.
    const roster: Source = {
      id: "src-roster",
      kind: "import",
      title: "Staff list",
      date: "2026-10-20",
    };
    const onRoster = {
      ...statement("st-roster", "Ops answers the phone."),
      sourceId: roster.id,
    };
    await shown(
      <StatementsByKind
        kern={{ interviewed: [], counts: [{ kind: "tool", count: 3 }] }}
        onRemove={() => {
          // Asked only once someone presses it.
        }}
        rows={[
          {
            statement: claim,
            place: { source: interviews, context: [], own: 0 },
          },
          { statement: added, place: { source: notes, context: [], own: 0 } },
          {
            statement: onRoster,
            place: { source: roster, context: [], own: 0 },
          },
        ]}
      />
    );
    const offered = [
      ...document.querySelectorAll<HTMLElement>("[data-statement]"),
    ].map((line) => ({
      id: line.dataset.statement,
      remove:
        line.querySelector(
          'button[aria-label="Remove this from the brain"]'
        ) !== null,
    }));
    expect(offered).toStrictEqual([
      { id: claim.id, remove: false },
      { id: added.id, remove: true },
      { id: onRoster.id, remove: true },
    ]);
  });

  it("shows a team's claim in plain words wherever it is named, and anyone's own words in quotation marks", () => {
    expect({
      claim: statementWords(
        "onb-st-0123456789abcdef0123456789abcdef",
        "Tickets come in through Zendesk."
      ),
      added: statementWords("st-zendesk", "Zendesk holds every ticket."),
    }).toStrictEqual({
      claim: "Tickets come in through Zendesk.",
      added: "“Zendesk holds every ticket.”",
    });
  });
});
