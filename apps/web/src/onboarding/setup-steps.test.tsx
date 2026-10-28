import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { noChoices } from "@grasp-os/shared/onboarding-choices";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import { noContext } from "@grasp-os/shared/onboarding-context";
import type { OnboardingContext } from "@grasp-os/shared/onboarding-context";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SetupFrame } from "./setup-frame.tsx";
import { SetupStepBody } from "./setup-steps.tsx";
import type { SetupData } from "./setup-steps.tsx";
import { listeningOf, stepIndex } from "./setup.ts";
import type { SetupStep } from "./setup.ts";
import { noteHeard } from "./visit.ts";

// What the onboarding's step tells the company's admin while Stephen talks
// to their people, from what it renders.

const today = "2026-10-14";

/** What the page's one route shows next. */
const onRoute: { node: ReactElement | null } = { node: null };

// Drawn once, a step asks core nothing: what it shows comes from what it is given.
const router = createRouter({
  routeTree: createRootRoute({ component: () => onRoute.node }),
  history: createMemoryHistory(),
  context: {
    core: {
      withSession: async () =>
        await Promise.reject(new Error("Not asked while drawn")),
    },
  },
});
await router.load();

/** Drawn as the page draws it: in the page's language, on its route. */
const page = (children: ReactElement): string => {
  onRoute.node = children;
  return renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nProvider>
  );
};

const view = (
  paused: boolean,
  sponsor: string | null,
  context: OnboardingContext
): OnboardingView => ({
  roster: null,
  plan: { start: "2026-10-12", days: 14 },
  progress: null,
  agreed: true,
  paused,
  sponsor,
  context,
  waiting: 0,
});

interface Shown {
  paused?: boolean;
  settled?: "mail"[];
  sponsor?: string | null;
  /** Stephen finished this step before. */
  seen?: boolean;
  choices?: SetupChoices;
  documents?: OnboardingDocument[];
  context?: OnboardingContext;
}

/** A step as it is drawn as it arrives, its markup and all. */
const drawn = (
  step: SetupStep,
  {
    paused = false,
    settled = [],
    sponsor = null,
    context = noContext,
    seen = false,
    choices = noChoices,
    documents = [],
  }: Shown
): string => {
  if (seen) {
    noteHeard(step);
  }
  const data: SetupData = {
    admin: "Ada",
    company: null,
    view: view(paused, sponsor, context),
    links: [],
    documents,
    sendingDomain: "mail.example.test",
    gate: {
      open: false,
      closedSince: null,
      threshold: 80,
      known: 10,
      parts: [],
      ready: false,
      over: false,
      openedAt: null,
      staff: null,
    },
    review: { differences: [], mapped: 0 },
    directory: null,
    hr: null,
    suites: [],
    places: null,
    choices,
    signIn: ["microsoft"],
    identity: {
      userId: "ada",
      email: "ada@acme.test",
      name: "Ada",
      role: "admin",
      teams: [],
      staff: false,
      expiresAt: "2026-10-15T00:00:00Z",
    },
  };
  return page(
    <SetupStepBody
      cramped={false}
      data={data}
      go={() => {}}
      listening={listeningOf(
        { roster: null, plan: data.view.plan, progress: null },
        today
      )}
      message={null}
      onMadeWay={() => {}}
      onMessage={() => {}}
      onSettle={() => {}}
      onStory={() => {}}
      parts={[]}
      percent={10}
      settled={settled}
      step={step}
      today={today}
    />
  );
};

/** What a step says, as text without its markup. */
const said = (step: SetupStep, shown: Shown): string =>
  drawn(step, shown)
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ");

describe("the step while Stephen talks to the team", () => {
  it("says the interviews are paused, while Grasp paused them", () => {
    const paused = said("listening", { paused: true });
    expect(paused).toContain(
      "Paused: no link opens and none goes out. The links that are due go out once they run again."
    );
    expect(paused.indexOf("Paused:")).toBeLessThan(
      paused.indexOf("Day 3 of 14")
    );
    expect(said("listening", {})).not.toContain("Paused:");
  });

  it("asks the admin to let Grasp's mail through, naming the sending domain, until they say it's done", () => {
    const open = said("listening", {});
    expect({
      asked: open.includes("Let Grasp’s mail through"),
      named: open.includes(
        "Apply it if the sender’s domain is mail.example.test."
      ),
      done: said("listening", { settled: ["mail"] }).includes(
        "Let Grasp’s mail through"
      ),
    }).toStrictEqual({ asked: true, named: true, done: false });
  });
});

describe("what needs the admin", () => {
  it("counts letting Grasp's mail through, and lets them go on once it's done", () => {
    const open = said("review", {});
    const done = said("review", { settled: ["mail"] });
    expect({
      open: [
        open.includes("Just one thing for you"),
        open.includes("Continue"),
      ],
      done: [
        done.includes("Nothing needs you"),
        done.includes("Settled: It’s done"),
        done.includes("Continue"),
      ],
    }).toStrictEqual({ open: [true, false], done: [true, true, true] });
  });
});

describe("the welcome", () => {
  it.each([
    {
      sponsor: "Anna",
      says: "Anna told me a lot about your company in our first conversation. Before we start, which language do you prefer?",
    },
    // The kickoff named no one: no one is named.
    { sponsor: null, says: "Ada, I’m Stephen Before we start, which language" },
  ])(
    "names the sponsor only when the kickoff gave a name ($sponsor)",
    ({ sponsor, says }) => {
      expect(said("welcome", { sponsor })).toContain(says);
    }
  );
});

describe("what Stephen says of the company", () => {
  const context: OnboardingContext = {
    suites: [],
    sources: [],
    words: {
      en: {
        business: "You build and renovate homes for housing associations.",
        documents: ["calculations", "supplier invoices"],
        example: null,
      },
    },
  };

  it("says what the company does as he says hello, before asking for the language", () => {
    expect(said("welcome", { sponsor: "Anna", context })).toContain(
      "Anna told me a lot about your company in our first conversation. You build and renovate homes for housing associations. Before we start, which language do you prefer?"
    );
  });
});

/** Whether anything on a step comes in as it arrives: a fade, a slide, a check drawn. */
const comesIn = (markup: string): boolean =>
  /animate-in|drawn-check/u.test(markup);

describe("a step the admin comes back to", () => {
  it("shows its way on at once, rather than after Stephen says it again", () => {
    // Held back (inert) until explained on arrival; there at once when seen before.
    expect({
      first: drawn("review", { settled: ["mail"] }).includes("inert"),
      again: drawn("review", { settled: ["mail"], seen: true }).includes(
        "inert"
      ),
    }).toStrictEqual({ first: true, again: false });
  });

  it("keeps the language chosen on the welcome, with Stephen's answer in full", () => {
    const answer = "English it is. This takes about 8 minutes. Ready to start?";
    expect({
      first: said("welcome", {}).includes(answer),
      again: said("welcome", { seen: true }).includes(answer),
    }).toStrictEqual({ first: false, again: true });
    expect(comesIn(drawn("welcome", { seen: true }))).toBeFalsy();
  });

  it("shows the places chosen for the documents at once, rather than held back and coming in", () => {
    const sharePoint: SetupChoices = { ...noChoices, sources: ["sharepoint"] };
    const first = drawn("sources", { choices: sharePoint });
    const again = drawn("sources", { choices: sharePoint, seen: true });
    expect({
      first: {
        noted: first.includes("Noted"),
        held: first.includes("inert"),
        comesIn: comesIn(first),
      },
      again: {
        noted: again.includes("Noted"),
        held: again.includes("inert"),
        comesIn: comesIn(again),
      },
    }).toStrictEqual({
      first: { noted: true, held: true, comesIn: true },
      again: { noted: true, held: false, comesIn: false },
    });
  });

  it("shows the documents shared, read, as they were left", () => {
    const handbook: OnboardingDocument = {
      id: "handbook",
      name: "Handbook.pdf",
      at: "2026-10-13T09:00:00Z",
      reading: {
        about: "How claims are handled, start to end.",
        tools: [],
        teams: [],
        unclear: [],
        ask: null,
      },
      answer: null,
    };
    const again = drawn("documents", { documents: [handbook], seen: true });
    expect({
      listed: again.includes("Handbook.pdf"),
      read: again.includes("How claims are handled, start to end."),
      held: again.includes("inert"),
      comesIn: comesIn(again),
    }).toStrictEqual({ listed: true, read: true, held: false, comesIn: false });
  });

  it("has the plan summed up at once on how this works", () => {
    const again = drawn("about", { seen: true });
    expect({
      summed: again.includes("Your people, documents and tools first."),
      comesIn: comesIn(again),
    }).toStrictEqual({ summed: true, comesIn: false });
  });
});

/** The ways back and forward the frame offers on `step`, the admin having been as far as `furthest`. */
const waysOn = (step: SetupStep, furthest: SetupStep) => {
  const markup = page(
    <SetupFrame
      knowledge={{ parts: [], percent: 10, threshold: 80 }}
      onExit={() => {}}
      onGo={() => {}}
      reached={stepIndex(furthest)}
      step={step}
    >
      {null}
    </SetupFrame>
  );
  return {
    back: markup.includes(">Back<"),
    forward: markup.includes(">Forward<"),
  };
};

describe("going back and forward", () => {
  it("goes back a step, and forward only as far as the admin has been", () => {
    expect({
      furthest: waysOn("documents", "documents"),
      behind: waysOn("company", "documents"),
      first: waysOn("welcome", "about"),
    }).toStrictEqual({
      furthest: { back: true, forward: false },
      behind: { back: true, forward: true },
      first: { back: false, forward: true },
    });
  });
});
