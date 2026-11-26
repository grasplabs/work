import { directoryErrors } from "@grasp-os/shared/directory";
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

import { InterviewsProgress } from "./interviews-progress.tsx";
import { SetupStepBody, directoryProblemOf } from "./setup-steps.tsx";
import type { SetupData, ShownStep } from "./setup-steps.tsx";
import { steps } from "./setup.ts";
import type { AiReadiness } from "./setup.ts";

// What the setup's steps tell the company's admin, and where the
// interviews stand, from what they render.

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
  context: OnboardingContext,
  mailSends: boolean,
  mailDomain: string | null,
  kickoff: OnboardingView["kickoff"]
): OnboardingView => ({
  roster: null,
  plan: { start: "2026-10-12", days: 14 },
  progress: null,
  agreed: true,
  paused,
  kickoff,
  teamsInBrain: null,
  sponsor,
  context,
  waiting: 0,
  mailSends,
  mailDomain,
});

interface Shown {
  paused?: boolean;
  settled?: "mail"[];
  sponsor?: string | null;
  choices?: SetupChoices;
  documents?: OnboardingDocument[];
  context?: OnboardingContext;
  /** Whether Grasp sends mail where it runs: it does unless said. */
  mailSends?: boolean;
  /** What Grasp's AI has to call: one provider, ready, unless said; null when core can't say. */
  ai?: AiReadiness | null;
  /** The domain core says its mail is from; a sender is set unless said. */
  mailDomain?: string | null;
  /** The kickoff: in when it named a sponsor, unless said. */
  kickoff?: OnboardingView["kickoff"];
}

/** What Grasp's AI has to call: Anthropic offered, and connected once a model is `ready`. */
const aiOf = ({ ready }: { ready: boolean }): AiReadiness => {
  const anthropic = {
    provider: "anthropic" as const,
    label: "Anthropic",
    whereItRuns: "Anthropic, United States",
    models: [
      { model: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    ],
  };
  return {
    ready,
    listing: {
      source: "own",
      grasp: {
        available: false,
        model: {
          model: "anthropic/claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
        },
        whereItRuns: "Anthropic, United States",
        month: { spentUsd: 0, limitUsd: 100, reached: false },
      },
      providers: ready
        ? [
            {
              ...anthropic,
              mask: "…a3f2",
              baseUrl: null,
              addedAt: 0,
              updatedAt: 0,
              status: null,
            },
          ]
        : [],
      offered: [anthropic],
      choice: null,
      platform: [],
    },
  };
};

/** A step as it is drawn as it arrives, its markup and all. */
const drawn = (
  step: ShownStep,
  {
    paused = false,
    settled = [],
    sponsor = null,
    context = noContext,
    choices = noChoices,
    documents = [],
    mailSends = true,
    ai = aiOf({ ready: true }),
    mailDomain = "mail.example.test",
    kickoff = sponsor === null ? null : "in",
  }: Shown
): string => {
  const data: SetupData = {
    admin: "Ada",
    company: null,
    view: view(paused, sponsor, context, mailSends, mailDomain, kickoff),
    links: [],
    documents,
    sendingDomain: mailDomain,
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
    suites: [],
    places: null,
    choices,
    signIn: ["microsoft"],
    ai,
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
      data={data}
      askedFor={0}
      go={() => {}}
      message={null}
      onMessage={() => {}}
      onSettle={() => {}}
      onward={async () => {}}
      path={steps}
      settled={settled}
      step={step}
      today={today}
    />
  );
};

/** What a step says, as text without its markup. */
const said = (step: ShownStep, shown: Shown): string =>
  drawn(step, shown)
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ");

/** Where the interviews stand, as text: team Ops quiet, its lead named `lead`, the interviews `paused` or not. */
const progressSaid = ({
  lead = "Lea Smit",
  paused = false,
}: {
  lead?: string;
  paused?: boolean;
}): string =>
  page(
    <InterviewsProgress
      links={[]}
      listening={{
        progress: 0.5,
        day: 7,
        days: 14,
        leadsHeard: 1,
        colleaguesHeard: 0,
        heard: [1],
      }}
      today={today}
      view={{
        ...view(paused, null, noContext, true, null, null),
        roster: {
          teams: [
            { id: "ops", name: "Ops", lead: "lea", does: "", off: false },
          ],
          people: [
            {
              id: "lea",
              name: lead,
              email: "",
              team: "ops",
              title: "",
              away: false,
            },
          ],
        },
        progress: {
          teams: [
            {
              id: "ops",
              name: "Ops",
              people: 6,
              off: false,
              leadTalked: true,
              talked: 0,
              asked: 5,
            },
          ],
          talked: 0,
          asked: 5,
          leadsTalked: 1,
          leads: 1,
          asOf: today,
        },
      }}
    />
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ");

describe("where the interviews stand", () => {
  it("says the interviews are paused, while Grasp paused them, before the days", () => {
    const paused = progressSaid({ paused: true });
    expect(paused).toContain(
      "Paused: no link opens and none goes out. The links that are due go out once they run again."
    );
    expect(paused.indexOf("Paused:")).toBeLessThan(
      paused.indexOf("Day 7 of 14")
    );
    expect(progressSaid({})).not.toContain("Paused:");
  });

  it("names a team far behind with its lead, and not at all once core erased the lead", () => {
    expect({
      named: progressSaid({}).includes(
        "Ops has been quiet so far. A short message from Lea, their lead, usually helps."
      ),
      erased: progressSaid({ lead: "" }).includes("has been quiet"),
    }).toStrictEqual({ named: true, erased: false });
  });
});

describe("a setup without a staff list", () => {
  it("asks who to talk to, by email or with a staff list, and lets the admin skip it for Grasp's staff", () => {
    const leads = said("leads", {});
    expect({
      said: leads.includes("Nobody on the list yet"),
      add: leads.includes("Add people"),
      skip: leads.includes("Skip for now"),
      hr: leads.includes("HR platform"),
    }).toStrictEqual({ said: true, add: true, skip: true, hr: false });
  });

  it("never holds the admin at the company step: they share a list, or skip it for Grasp's staff to sort out", () => {
    const company = said("company", {});
    expect({
      share: company.includes("Share a staff list"),
      skip: company.includes("Skip for now"),
      sortedOut: company.includes("we’ll sort it out with you"),
    }).toStrictEqual({ share: true, skip: true, sortedOut: true });
  });

  it("asks for the message alone on the team step: Grasp's staff plan the day", () => {
    const team = said("team", {});
    expect({
      plans: team.includes("Grasp’s staff plan the day I start with you."),
      day: team.includes("Tomorrow"),
      sent: team.includes("Continue"),
    }).toStrictEqual({ plans: true, day: false, sent: true });
  });
});

describe("the AI step", () => {
  it("asks for a key until a model is ready for calls, with Continue to send it, and goes on once one is or core can't say", () => {
    const asked = said("ai", { ai: aiOf({ ready: false }) });
    const ready = said("ai", {});
    const unknown = said("ai", { ai: null });
    expect({
      // Asked for a key: the step says so (the providers stand on the page, with no card titled for it).
      asked: [asked.includes("Paste an API key"), asked.includes("Continue")],
      ready: [
        ready.includes("Your API key is connected"),
        ready.includes("Continue"),
      ],
      unknown: [
        unknown.includes("Paste an API key"),
        unknown.includes("Continue"),
      ],
    }).toStrictEqual({
      asked: [true, true],
      ready: [true, true],
      unknown: [false, true],
    });
  });

  it("offers our own system first where this deployment has it, so Continue goes on with no key", () => {
    const own = aiOf({ ready: false });
    const offered: AiReadiness = {
      ...own,
      listing: {
        ...own.listing,
        grasp: { ...own.listing.grasp, available: true },
      },
    };
    const shown = said("ai", { ai: offered });
    const notOffered = said("ai", { ai: own });
    expect({
      offered: [
        shown.includes("Use our built-in system"),
        shown.includes("Use your own API key"),
        shown.includes("Continue"),
      ],
      notOffered: notOffered.includes("Use our built-in system"),
    }).toStrictEqual({
      offered: [true, true, true],
      notOffered: false,
    });
  });
});

describe("the welcome", () => {
  it("offers to forget the kickoff while it is in, and says when its erasure finishes by itself", () => {
    const offer = "Forget our first conversation";
    const erasing = "I’m still clearing what I learned from it";
    const shown = (kickoff: OnboardingView["kickoff"]) => {
      const markup = drawn("welcome", { kickoff });
      return {
        offer: markup.includes(offer),
        erasing: markup.includes(erasing),
      };
    };
    expect({
      in: shown("in"),
      erasing: shown("erasing"),
      none: shown(null),
    }).toStrictEqual({
      in: { offer: true, erasing: false },
      erasing: { offer: false, erasing: true },
      none: { offer: false, erasing: false },
    });
  });
});

describe("the documents and places the admin comes back to", () => {
  it("shows the places chosen for the documents as noted", () => {
    const sharePoint: SetupChoices = { ...noChoices, sources: ["sharepoint"] };
    // Said after its name; the helper puts a space between the name and the words after it.
    expect(said("sources", { choices: sharePoint })).toMatch(
      /SharePoint ?, noted/u
    );
  });

  it("lists the documents shared before, each one the admin can remove", () => {
    const handbook: OnboardingDocument = {
      id: "handbook",
      name: "Handbook.pdf",
      at: "2026-10-13T09:00:00Z",
      reading: {
        about: "How claims are handled, start to end.",
        tools: [],
        teams: [],
        unclear: [],
      },
    };
    const again = drawn("documents", { documents: [handbook] });
    expect({
      listed: again.includes("Handbook.pdf"),
      removable: again.includes('aria-label="Remove Handbook.pdf"'),
    }).toStrictEqual({ listed: true, removable: true });
  });
});

describe("a directory the company step couldn't read", () => {
  it("asks for an admin's account where the account that connected it can't read it, as for one that needs connecting again", () => {
    const problems = Object.fromEntries(
      (
        [
          "directory.not_admin",
          "directory.inactive",
          "directory.not_connected",
          "directory.too_large",
          "directory.provider_failed",
        ] as const
      ).map((code) => [code, directoryProblemOf(directoryErrors.create(code))])
    );

    expect(problems).toStrictEqual({
      "directory.not_admin": "inactive",
      "directory.inactive": "inactive",
      "directory.not_connected": "inactive",
      "directory.too_large": "large",
      "directory.provider_failed": "failed",
    });
  });
});
