// @vitest-environment happy-dom
import { onboardingErrors } from "@grasp-os/shared/onboarding";
import type { LinkToSend, OnboardingView } from "@grasp-os/shared/onboarding";
import type {
  Campaign,
  CampaignTeam,
} from "@grasp-os/shared/onboarding-campaign";
import { noContext } from "@grasp-os/shared/onboarding-context";
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

import { InterviewsPanel } from "./interviews.tsx";

// Settings › Interviews, on what core answers the company's admin
// (`onboarding.campaign`, `links` and `view`): where the interviews stand,
// what stays hidden of a small team, and what the admin does from here: a
// nudge, a corrected address, a link marked as sent. Core is a fake that
// keeps what it was asked and answers as the real one would.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const team = (
  id: string,
  name: string,
  numbers: Partial<CampaignTeam> = {}
): CampaignTeam => ({
  id,
  name,
  led: true,
  leadTalked: true,
  asked: 10,
  talked: 6,
  inProgress: 1,
  notStarted: 3,
  byDay: [2, 4, 0, 0, 0],
  quiet: false,
  ...numbers,
});

/** Day 3 of 5: Sales well under way, Ops quiet, Legal too small to show. */
const campaign: Campaign = {
  start: "2026-11-23",
  days: 5,
  closes: "2026-11-27",
  today: "2026-11-25",
  asked: 16,
  talked: 6,
  leads: 3,
  leadsTalked: 2,
  teams: [
    team("sales", "Sales"),
    team("ops", "Ops", {
      leadTalked: false,
      asked: 6,
      talked: null,
      inProgress: null,
      notStarted: null,
      byDay: null,
      quiet: true,
    }),
    team("legal", "Legal", {
      asked: null,
      talked: null,
      inProgress: null,
      notStarted: null,
      byDay: null,
    }),
  ],
  asks: [
    { kind: "quiet", team: "ops", name: "Ops", waiting: 6, nudged: false },
    {
      kind: "mail",
      person: "ben",
      name: "Ben Bos",
      team: "Sales",
      email: "ben@acme.tset",
    },
  ],
  known: 75,
  threshold: 80,
  ready: false,
};

const view: OnboardingView = {
  roster: {
    teams: [
      { id: "sales", name: "Sales", lead: "sam", does: "", off: false },
      { id: "ops", name: "Ops", lead: "lea", does: "", off: false },
      { id: "legal", name: "Legal", lead: "lou", does: "", off: false },
    ],
    people: [
      {
        id: "lea",
        name: "Lea Smit",
        email: "lea@acme.test",
        team: "ops",
        title: "",
        away: false,
      },
    ],
  },
  plan: { start: "2026-11-23", days: 5 },
  progress: null,
  agreed: true,
  paused: false,
  kickoff: null,
  teamsInBrain: null,
  sponsor: null,
  context: noContext,
  waiting: 0,
  mailSends: true,
  mailDomain: "mail.grasp.test",
};

const link = (
  person: string,
  name: string,
  more: Partial<LinkToSend> = {}
): LinkToSend => ({
  person,
  name,
  team: "Sales",
  email: `${person}@acme.test`,
  path: `/interview/${person}#secret`,
  fresh: true,
  mailFailed: false,
  ...more,
});

/** What the fake core holds, and what it was asked to do. */
interface Fake {
  campaign: Campaign | null;
  view: OnboardingView;
  links: LinkToSend[];
  /** How core answers a nudge: how many it mailed, or the refusal it throws. */
  nudge: () => number;
  /** How core answers a corrected address: nothing, or the refusal it throws. */
  correct?: () => void;
  asked: string[];
}

const fakeOf = (over: Partial<Fake> = {}): Fake => ({
  campaign,
  view,
  links: [],
  nudge: () => 4,
  asked: [],
  ...over,
});

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

/** The section, on a core that answers from `fake`. */
const shown = async (fake: Fake): Promise<void> => {
  const session = {
    onboarding: {
      view: async () => await Promise.resolve(fake.view),
      campaign: async () => await Promise.resolve(fake.campaign),
      links: async () => await Promise.resolve(fake.links),
      nudge: async (id: string) => {
        fake.asked.push(`nudge ${id}`);
        return await Promise.resolve({ mailed: fake.nudge() });
      },
      correctAddress: async (person: string, email: string) => {
        fake.asked.push(`correct ${person} ${email}`);
        fake.correct?.();
        // Sent again: the mail is no longer one that failed.
        if (fake.campaign !== null) {
          fake.campaign = {
            ...fake.campaign,
            asks: fake.campaign.asks.filter(
              (ask) => ask.kind !== "mail" || ask.person !== person
            ),
          };
        }
        await Promise.resolve();
      },
      linksTaken: async (people: string[]) => {
        fake.asked.push(`taken ${people.join(",")}`);
        fake.links = fake.links.map((each) =>
          people.includes(each.person) ? { ...each, fresh: false } : each
        );
        await Promise.resolve();
      },
    },
  };
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: InterviewsPanel }),
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
  await settled();
};

/** An element's words as a screen reader hears them: what is hidden from it left out. */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent?.replaceAll(/\s+/gu, " ").trim() ?? "";
};

/** The element matching `selector` with these words, or this name. */
const found = (selector: string, words: string): HTMLElement => {
  const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (each) =>
      wordsOf(each) === words || each.getAttribute("aria-label") === words
  );
  if (element === undefined) {
    throw new TypeError(`No ${selector} ${words}`);
  }
  return element;
};

/** Whether the page has a button with these words, or this name. */
const hasButton = (words: string): boolean =>
  [...document.querySelectorAll("button")].some(
    (each) =>
      wordsOf(each) === words || each.getAttribute("aria-label") === words
  );

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** What the section of this name says. */
const groupText = (name: string): string => {
  const heading = [...document.querySelectorAll("section")].find((section) => {
    const id = section.getAttribute("aria-labelledby");
    const title =
      id === null ? null : document.querySelector(`#${CSS.escape(id)}`);
    return title !== null && wordsOf(title) === name;
  });
  if (heading === undefined) {
    throw new TypeError(`No section ${name}`);
  }
  return wordsOf(heading);
};

/** The whole page's words. */
const pageText = (): string => wordsOf(document.body);

/** An address typed into the one open address form. */
const typedAddress = async (address: string): Promise<void> => {
  const input = document.querySelector<HTMLInputElement>(
    'form input[type="email"]'
  );
  await act(async () => {
    if (input !== null) {
      Reflect.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, address);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await Promise.resolve();
  });
};

describe("Settings › Interviews", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("says where the interviews stand: who talked, the day, the close and how near Grasp's go is", async () => {
    await shown(fakeOf());
    const text = pageText();

    expect({
      colleagues: text.includes("Colleagues talked6 of 16"),
      leads: text.includes("Team leads talked2 of 3"),
      day: text.includes("Day3 of 5"),
      closes: text.includes("Closes Nov 27, 2026"),
      known: text.includes("Grasp knows75%"),
      go: text.includes("Grasp opens from 80%"),
      sales: groupText("By team").includes(
        "6 of 10 talked, 1 in progress, 3 not started."
      ),
    }).toStrictEqual({
      colleagues: true,
      leads: true,
      day: true,
      closes: true,
      known: true,
      go: true,
      sales: true,
    });
  });

  it("shows no numbers of a team too small, or where too few talked, and offers the small one no nudge", async () => {
    await shown(fakeOf());
    const teams = groupText("By team");

    expect({
      small: teams.includes(
        "Fewer than 5 people were asked: too few to show numbers."
      ),
      few: teams.includes(
        "6 asked. Fewer than 3 have talked: too few to show more."
      ),
      nudgeSmall: hasButton("Nudge Legal"),
      nudgeQuiet: hasButton("Nudge Ops"),
      waiting: groupText("Still to talk").includes(
        "One team is too small to show how many of it are still to talk."
      ),
    }).toStrictEqual({
      small: true,
      few: true,
      nudgeSmall: false,
      nudgeQuiet: true,
      waiting: true,
    });
  });

  it("names a lead still to talk, and everyone else only as a number per team", async () => {
    await shown(fakeOf());
    const waiting = groupText("Still to talk");

    expect({
      lead: waiting.includes("Lea Smit, its lead, hasn’t talked yet."),
      sales: waiting.includes(
        "4 people are still to talk; 3 of them haven’t started."
      ),
      ops: waiting.includes("Fewer than 3 of its 6 have talked so far."),
    }).toStrictEqual({ lead: true, sales: true, ops: true });
  });

  it("nudges a team and says how many were mailed", async () => {
    const fake = fakeOf();
    await shown(fake);

    await click(found("button", "Nudge Ops"));

    expect({
      asked: fake.asked,
      said: groupText("By team").includes("Your nudge went to 4 people."),
      again: hasButton("Nudge Ops"),
    }).toStrictEqual({ asked: ["nudge ops"], said: true, again: false });
  });

  it("says why core refused a nudge: a team too small, or one nudged today already", async () => {
    const small = fakeOf({
      nudge: () => {
        throw onboardingErrors.create("onboarding.team_too_small");
      },
    });
    await shown(small);
    await click(found("button", "Nudge Sales"));
    const tooSmall = groupText("By team");
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";

    const today = fakeOf({
      nudge: () => {
        throw onboardingErrors.create("onboarding.nudged_today");
      },
    });
    await shown(today);
    await click(found("button", "Nudge Sales"));

    expect({
      tooSmall: tooSmall.includes(
        "A team shows its numbers, and takes a nudge, only once five people in it were asked."
      ),
      today: groupText("By team").includes(
        "That team got your nudge today already. You can nudge it again tomorrow."
      ),
    }).toStrictEqual({ tooSmall: true, today: true });
  });

  it("says core's refusal at the address being corrected, and keeps the mail on the list", async () => {
    const fake = fakeOf({
      correct: () => {
        throw onboardingErrors.create("onboarding.invalid");
      },
    });
    await shown(fake);

    await click(found("button", "Correct the address of Ben Bos"));
    await typedAddress("ben@acme.test");
    await click(found("button", "Send again"));
    const links = groupText("Links");

    expect({
      asked: fake.asked,
      refused: links.includes("That isn't something the onboarding takes."),
      listed: links.includes("Ben Bos"),
    }).toStrictEqual({
      asked: ["correct ben ben@acme.test"],
      refused: true,
      listed: true,
    });
  });

  it("sends a corrected address, and the mail leaves the list", async () => {
    const fake = fakeOf();
    await shown(fake);
    const before = groupText("Links").includes(
      "Our email to ben@acme.tset didn’t arrive."
    );

    await click(found("button", "Correct the address of Ben Bos"));
    await typedAddress("ben@acme.test");
    await click(found("button", "Send again"));

    expect({
      before,
      asked: fake.asked,
      after: groupText("Links").includes("Ben Bos"),
    }).toStrictEqual({
      before: true,
      asked: ["correct ben ben@acme.test"],
      after: false,
    });
  });

  it("lists the links to send by hand where Grasp sends no mail, and takes one off once marked as sent", async () => {
    const fake = fakeOf({
      campaign: { ...campaign, asks: [] },
      view: { ...view, mailSends: false, mailDomain: null },
      links: [
        link("ada", "Ada Lund"),
        link("cas", "Cas Visser"),
        link("dee", "Dee Koch", { fresh: false }),
        link("eli", "Eli Maas", { path: null, fresh: false }),
      ],
    });
    await shown(fake);
    const before = groupText("Links");

    await click(found("button", "Mark the link for Ada Lund as sent"));
    const after = groupText("Links");

    expect({
      listed: before.includes("Ada Lund") && before.includes("Cas Visser"),
      sentBefore: before.includes("Dee Koch"),
      notOut: before.includes("Eli Maas"),
      out: before.includes("3 of 4 links are out."),
      asked: fake.asked,
      ada: after.includes("Ada Lund"),
      cas: after.includes("Cas Visser"),
    }).toStrictEqual({
      listed: true,
      sentBefore: false,
      notOut: false,
      out: true,
      asked: ["taken ada"],
      ada: false,
      cas: true,
    });
  });

  it("lists no link to send where Grasp emails them itself", async () => {
    await shown(
      fakeOf({
        campaign: { ...campaign, asks: [] },
        links: [link("ada", "Ada Lund")],
      })
    );

    expect({
      listed: groupText("Links").includes("Ada Lund"),
      said: groupText("Links").includes("Nothing to do: no email failed."),
    }).toStrictEqual({ listed: false, said: true });
  });

  it("says what keeps the links in: the interviews paused, the agreements not in place", async () => {
    await shown(fakeOf({ view: { ...view, paused: true, agreed: false } }));
    const text = pageText();

    expect({
      paused: text.includes("Grasp paused the interviews"),
      agreements: text.includes(
        "Grasp is still putting the agreements in place."
      ),
    }).toStrictEqual({ paused: true, agreements: true });
  });

  it("says there are no interviews yet before the list and the plan are in, with the way to the onboarding", async () => {
    await shown(fakeOf({ campaign: null }));

    expect({
      said: pageText().includes("No interviews yet"),
      way: found("a", "Open the onboarding").getAttribute("href"),
    }).toStrictEqual({ said: true, way: "/setup" });
  });
});
