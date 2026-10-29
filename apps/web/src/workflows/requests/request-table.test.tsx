// @vitest-environment happy-dom
import { rangeSpan, requestsReport } from "@grasp-os/shared/stephen-requests";
import type {
  Need,
  NeedStatus,
  RequestsFilter,
  RequestsPage,
  StephenRequest,
} from "@grasp-os/shared/stephen-requests";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { RequestTable } from "./request-table.tsx";

// The table of Workflows › Requests against core's `stephenRequests` as the
// page reaches it over RPC, faked: it keeps what an owner marks and
// answers a panel's read with the report narrowed as core would narrow
// it. What the table shows is what core served, folded already.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const today = "2026-10-27";

/** Requests of five people asking the leave question he can't do, and six answered about expenses. */
const requests: StephenRequest[] = [
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `teams:leave-${index}`,
    day: "2026-10-20",
    place: "teams",
    personId: `p${index}`,
    teamId: "team-sales",
    kind: "changed" as const,
    outcome: "notPossible" as const,
    topic: "topic-leave",
    question: "q-leave",
    tools: [],
    missing: [{ id: "afas.leave", why: "actionOff" as const }],
    rating: null,
  })),
  ...Array.from({ length: 6 }, (_, index) => ({
    id: `teams:expenses-${index}`,
    day: "2026-10-21",
    place: "teams",
    personId: `e${index}`,
    teamId: "team-sales",
    kind: "answered" as const,
    outcome: "done" as const,
    topic: "topic-expenses",
    question: null,
    tools: [{ id: "brain", ok: true }],
    missing: [],
    rating: null,
  })),
];

const reach = new Map([["team-sales", 12]]);

/** The page as core serves it, narrowed by `filter`. */
const pageOf = (filter: Partial<RequestsFilter> = {}): RequestsPage => {
  const shown = requests.filter(
    (each) =>
      (filter.question === undefined || each.question === filter.question) &&
      (filter.topic === undefined || each.topic === filter.topic)
  );
  return {
    today,
    range: "month",
    tooFew: false,
    report: requestsReport(shown, rangeSpan("month", today), {
      perPerson: false,
      reach,
    }),
    before: null,
    settings: {
      requestsIncluded: 400,
      minutesSaved: {},
      requestsPerPerson: false,
    },
    pace: 30,
    topics: [
      { id: "topic-leave", name: "Leave and absence" },
      { id: "topic-expenses", name: "Expenses" },
    ],
    questions: [
      { id: "q-leave", name: "Request leave for next week", role: null },
    ],
    teams: [{ id: "team-sales", name: "Sales", reach: 12 }],
    people: [],
    places: ["teams"],
    canSetPerPerson: true,
  };
};

const leave: Need = {
  key: "notPossible:q-leave",
  kind: "notPossible",
  topic: "topic-leave",
  question: "q-leave",
  teamId: null,
  label: "Request leave for next week",
  people: 5,
  requests: 5,
  reach: null,
  thumbs: null,
  missing: [{ id: "afas.leave", why: "actionOff" }],
  role: null,
  proposal: "Turn on Request leave in AFAS.",
  status: null,
  since: null,
};

let root: Root | undefined;

/** The table on `page`, with core faked behind it; what was marked and asked. */
const shown = async (page: RequestsPage, needs: Need[]) => {
  const marked: [string, NeedStatus | null][] = [];
  const read: Partial<RequestsFilter>[] = [];
  const switched: boolean[] = [];
  const stephenRequests = {
    report: async (filter: RequestsFilter): Promise<RequestsPage> => {
      await Promise.resolve();
      read.push(filter);
      return pageOf(filter);
    },
    setNeedStatus: async (key: string, status: NeedStatus | null) => {
      await Promise.resolve();
      marked.push([key, status]);
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        stephenRequests: typeof stephenRequests;
      }) => Promise<T>
    ): Promise<T> => await action({ stephenRequests }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <RequestTable
        busy={false}
        needs={needs}
        onChanged={async () => {
          await Promise.resolve();
        }}
        onOnlyTeam={null}
        onPerPerson={(on) => {
          switched.push(on);
        }}
        page={page}
        place={null}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
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
  return { marked, read, switched };
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The button whose text starts with `name`. */
const button = (name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll("button, [role='tab'], [role='menuitem']"),
  ].find((each) => each.textContent?.trim().startsWith(name));
  if (!(found instanceof HTMLElement)) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

describe("the requests table", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("opens on what needs fixing, its panel narrowed to it with Grasp's proposal, and marks it fixed", async () => {
    const { marked, read } = await shown(pageOf(), [leave]);

    await press(button("Request leave for next week"));
    const panel = document.body.textContent ?? "";
    await press(button("Mark as"));
    await press(button("Fixed"));

    expect({
      why: panel.includes("Off in afas"),
      proposal: panel.includes("Turn on Request leave in AFAS."),
      asked: panel.includes("Asked 5 times · 5 people"),
      read,
      marked,
    }).toStrictEqual({
      why: true,
      proposal: true,
      asked: true,
      read: [{ range: "month", place: null, question: "q-leave" }],
      marked: [["notPossible:q-leave", "fixed"]],
    });
  });

  it("shows what people ask by topic, and people one by one only once an owner turns them on", async () => {
    const { switched } = await shown(pageOf(), []);

    await press(button("What people ask"));
    const topics = [...document.querySelectorAll("li")].map(
      (each) => each.textContent ?? ""
    );
    await press(button("People"));
    const people = document.body.textContent ?? "";
    await press(button("Show people one by one"));

    expect({
      expenses: topics.some((each) => each.startsWith("Expenses")),
      worksCouncil: people.includes("works council"),
      switched,
    }).toStrictEqual({ expenses: true, worksCouncil: true, switched: [true] });
  });
});
