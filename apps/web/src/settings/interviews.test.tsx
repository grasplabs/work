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
// reminder to the teams ticked, a corrected address, a link marked as
// sent. Core is a fake that keeps what it was asked and answers as the
// real one would.

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
  /** How core answers a reminder for a team: how many it mailed, or the refusal it throws. */
  nudge: (team: string) => number;
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
        return await Promise.resolve({ mailed: fake.nudge(id) });
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

/** Words typed into the one field matching `selector`. */
const typed = async (selector: string, words: string): Promise<void> => {
  const input = document.querySelector<HTMLInputElement>(selector);
  await act(async () => {
    if (input !== null) {
      Reflect.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, words);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await Promise.resolve();
  });
  await settled();
};

/** The table of this name. */
const tableOf = (name: string): HTMLElement => found("table", name);

/** What each row of a table's body says, in order. */
const rowsOf = (name: string): string[] =>
  [...tableOf(name).querySelectorAll("tbody tr")].map((row) => wordsOf(row));

/** The first cell's words of each row of a table's body: who the rows are, in order. */
const namesOf = (name: string, column = 0): string[] =>
  [...tableOf(name).querySelectorAll("tbody tr")].map((row) =>
    wordsOf(row.querySelectorAll("th, td")[column] ?? row)
  );

/** The checkbox its label names, in the links' table. */
const tickOf = (name: string): HTMLElement => {
  const tick = found("label", name)
    .closest("td")
    ?.querySelector<HTMLElement>('[role="checkbox"]');
  if (tick === null || tick === undefined) {
    throw new TypeError(`No checkbox ${name}`);
  }
  return tick;
};

/** A row's menu, opened, and the item of these words pressed. */
const chosen = async (person: string, item: string): Promise<void> => {
  await click(found("button", `Actions for ${person}`));
  await click(found('[role="menuitem"]', item));
};

/** What the open menu offers. */
const menuItems = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
    wordsOf(item)
  );

/** Forty people whose links are out, to send by hand. */
const manyLinks = (count: number): LinkToSend[] =>
  Array.from({ length: count }, (_, index) =>
    link(`p${index}`, `Person ${String(index).padStart(2, "0")}`)
  );

/** A company that sends its links by hand, with nothing failed. */
const byHand = (links: LinkToSend[]): Fake =>
  fakeOf({
    campaign: { ...campaign, asks: [] },
    view: { ...view, mailSends: false, mailDomain: null },
    links,
  });

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
      bars: [...document.querySelectorAll('[role="progressbar"]')]
        .map((bar) => bar.getAttribute("aria-label"))
        .filter(
          (name) => name === "Colleagues talked" || name === "Grasp knows"
        ),
    }).toStrictEqual({
      colleagues: true,
      leads: true,
      day: true,
      closes: true,
      known: true,
      go: true,
      bars: ["Colleagues talked", "Grasp knows"],
    });
  });

  it("says in one line what needs the admin, each part a way to its table", async () => {
    await shown(fakeOf());
    const parts = [...found("ul", "What needs you").querySelectorAll("a")].map(
      (part) => `${wordsOf(part)} ${part.getAttribute("href")}`
    );

    expect(parts).toStrictEqual([
      "1 email didn’t arrive #interview-links",
      "1 team lead hasn’t talked #interview-teams",
      "1 quiet team #interview-teams",
    ]);
  });

  it("says calmly that nothing needs the admin when nothing does", async () => {
    await shown(
      fakeOf({
        campaign: {
          ...campaign,
          teams: [team("sales", "Sales")],
          asks: [],
        },
      })
    );

    expect({
      calm: pageText().includes("Nothing needs you right now."),
      line: document.querySelector('ul[aria-label="What needs you"]'),
    }).toStrictEqual({ calm: true, line: null });
  });

  it("shows the links that need the admin again when the line's part is followed", async () => {
    const fake = fakeOf({ links: [link("ada", "Ada Lund")] });
    await shown(fake);
    await click(found("button", "All"));
    const all = namesOf("Links");

    await click(found("a", "1 email didn’t arrive"));

    expect({ all, after: namesOf("Links") }).toStrictEqual({
      all: ["Ben Bos", "Ada Lund"],
      after: ["Ben Bos"],
    });
  });

  it("lists every team once with its lead, its numbers and one status", async () => {
    await shown(fakeOf());

    expect(rowsOf("Teams")).toStrictEqual([
      "Sales1064",
      "OpsLea SmitHasn’t talked yet6Too few to showQuiet",
      "Fewer than 5 people were asked in this team, so no reminder goes to it.LegalToo few to show",
    ]);
  });

  it("shows no numbers of a team too small, and lets nobody tick it, with why", async () => {
    await shown(fakeOf());
    const tick = found('[role="checkbox"]', "Select Legal");
    const why = tick.getAttribute("aria-describedby");

    expect({
      row: rowsOf("Teams").at(-1)?.endsWith("LegalToo few to show"),
      off:
        tick.hasAttribute("disabled") ||
        tick.getAttribute("aria-disabled") === "true",
      why:
        why === null
          ? null
          : document.querySelector(`#${CSS.escape(why)}`)?.textContent,
    }).toStrictEqual({
      row: true,
      off: true,
      why: "Fewer than 5 people were asked in this team, so no reminder goes to it.",
    });
  });

  it("sends the reminder to the teams ticked, one after the other, and says how many were mailed", async () => {
    const fake = fakeOf({ nudge: (id) => (id === "sales" ? 4 : 6) });
    await shown(fake);
    const before = hasButton("Send reminder");

    await click(found('[role="checkbox"]', "Select Sales"));
    await click(found('[role="checkbox"]', "Select Ops"));
    await click(found("button", "Send reminder to 2 teams"));

    expect({
      before,
      asked: fake.asked,
      said: groupText("Teams").includes(
        "Your reminder went to 10 people in 2 teams."
      ),
      cleared: hasButton("Send reminder"),
      reminded: rowsOf("Teams").filter((row) => row.includes("Reminded today"))
        .length,
    }).toStrictEqual({
      before: true,
      asked: ["nudge sales", "nudge ops"],
      said: true,
      cleared: true,
      reminded: 2,
    });
  });

  it("says per team why core sent it no reminder, beside the teams it did mail", async () => {
    const fake = fakeOf({
      nudge: (id) => {
        if (id === "ops") {
          throw onboardingErrors.create("onboarding.nudged_today");
        }
        return 4;
      },
    });
    await shown(fake);

    await click(
      found('[role="checkbox"]', "Select every team a reminder can go to")
    );
    await click(found("button", "Send reminder to 2 teams"));
    const teams = groupText("Teams");

    expect({
      asked: fake.asked,
      mailed: teams.includes("Your reminder went to 4 people in 1 team."),
      refused: teams.includes(
        "Ops got no reminder. That team got your reminder today already. You can remind it again tomorrow."
      ),
    }).toStrictEqual({
      asked: ["nudge sales", "nudge ops"],
      mailed: true,
      refused: true,
    });
  });

  it("lets no reminder go to a team reminded today, where everyone talked, or outside the plan's days", async () => {
    const reasonOf = (name: string): string | null | undefined => {
      const why = found('[role="checkbox"]', `Select ${name}`).getAttribute(
        "aria-describedby"
      );
      return why === null
        ? null
        : document.querySelector(`#${CSS.escape(why)}`)?.textContent;
    };
    await shown(
      fakeOf({
        campaign: {
          ...campaign,
          teams: [
            team("sales", "Sales", {
              talked: 10,
              inProgress: 0,
              notStarted: 0,
            }),
            team("ops", "Ops", { quiet: true }),
          ],
          asks: [
            {
              kind: "quiet",
              team: "ops",
              name: "Ops",
              waiting: 4,
              nudged: true,
            },
          ],
        },
      })
    );
    const running = { sales: reasonOf("Sales"), ops: reasonOf("Ops") };
    const statuses = rowsOf("Teams");
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";

    await shown(fakeOf({ campaign: { ...campaign, today: "2026-11-30" } }));

    expect({
      running,
      statuses,
      over: reasonOf("Sales"),
    }).toStrictEqual({
      running: {
        sales: "Everyone in this team has talked.",
        ops: "This team got your reminder today. The next one can go tomorrow.",
      },
      statuses: [
        "This team got your reminder today. The next one can go tomorrow.OpsLea Smit1064Reminded today",
        "Everyone in this team has talked.Sales10100Everyone talked",
      ],
      over: "A reminder goes only on the days the interviews run.",
    });
  });

  it("starts with the team with most still to talk, what core hides last, and sorts by a column pressed", async () => {
    const fake = fakeOf({
      campaign: {
        ...campaign,
        teams: [
          team("legal", "Legal", {
            asked: null,
            talked: null,
            inProgress: null,
            notStarted: null,
            byDay: null,
          }),
          team("sales", "Sales"),
          team("finance", "Finance", { asked: 20, talked: 5 }),
        ],
      },
    });
    await shown(fake);
    const first = namesOf("Teams", 1);
    const sortedBy = (): string[] =>
      [...tableOf("Teams").querySelectorAll("th[aria-sort]")]
        .filter((head) => head.getAttribute("aria-sort") !== "none")
        .map((head) => `${wordsOf(head)} ${head.getAttribute("aria-sort")}`);
    const firstSort = sortedBy();

    await click(found("table th button", "Team"));

    expect({
      first,
      firstSort,
      byName: namesOf("Teams", 1),
      nameSort: sortedBy(),
    }).toStrictEqual({
      first: ["Finance", "Sales", "Legal"],
      firstSort: ["Still to talk descending"],
      byName: ["Finance", "Legal", "Sales"],
      nameSort: ["Team ascending"],
    });
  });

  it("shows the links that need the admin first, every link that is out on All, and narrows them by a search", async () => {
    const fake = fakeOf({
      links: [
        link("ada", "Ada Lund", { team: "Ops" }),
        link("cas", "Cas Visser"),
        link("eli", "Eli Maas", { path: null, fresh: false }),
      ],
    });
    await shown(fake);
    const first = rowsOf("Links");

    await click(found("button", "All"));
    const all = rowsOf("Links");
    await typed('input[aria-label="Search links"]', "ops");

    expect({ first, all, found: namesOf("Links") }).toStrictEqual({
      first: ["Ben BosSalesben@acme.tsetDidn’t arrive"],
      all: [
        "Ben BosSalesben@acme.tsetDidn’t arrive",
        "Ada LundOpsada@acme.testSent",
        "Cas VisserSalescas@acme.testSent",
      ],
      found: ["Ada Lund"],
    });
  });

  it("says core's refusal at the address being corrected, and keeps the mail on the list", async () => {
    const fake = fakeOf({
      correct: () => {
        throw onboardingErrors.create("onboarding.invalid");
      },
    });
    await shown(fake);

    await chosen("Ben Bos", "Correct the address");
    await typed('form input[type="email"]', "ben@acme.test");
    await click(found("button", "Send again"));

    expect({
      asked: fake.asked,
      refused: wordsOf(
        found("form", "Correct the address of Ben Bos")
      ).includes("That isn't something the onboarding takes."),
      listed: namesOf("Links"),
    }).toStrictEqual({
      asked: ["correct ben ben@acme.test"],
      refused: true,
      listed: ["Ben Bos"],
    });
  });

  it("sends a corrected address, and the mail leaves what needs the admin", async () => {
    const fake = fakeOf();
    await shown(fake);
    const before = namesOf("Links");

    await chosen("Ben Bos", "Correct the address");
    await typed('form input[type="email"]', "ben@acme.test");
    await click(found("button", "Send again"));
    const links = groupText("Links");

    expect({
      before,
      asked: fake.asked,
      table: document.querySelector('table[aria-label="Links"]'),
      calm: links.includes("Every invitation was delivered."),
      form: document.querySelector('form input[type="email"]'),
    }).toStrictEqual({
      before: ["Ben Bos"],
      asked: ["correct ben ben@acme.test"],
      table: null,
      calm: true,
      form: null,
    });
  });

  it("offers each link only what can be done with it", async () => {
    const fake = byHand([
      link("ada", "Ada Lund"),
      link("dee", "Dee Koch", { fresh: false }),
    ]);
    await shown(fake);
    await click(found("button", "All"));
    await click(found("button", "Actions for Ada Lund"));
    const toSend = menuItems();
    await click(found('[role="menuitem"]', "Copy link"));
    await click(found("button", "Actions for Dee Koch"));

    expect({ toSend, sent: menuItems() }).toStrictEqual({
      toSend: ["Copy link", "Mark as sent"],
      sent: ["Copy link"],
    });
  });

  it("lists the links to send by hand where Grasp sends no mail, and takes one off once marked as sent", async () => {
    const fake = byHand([
      link("ada", "Ada Lund"),
      link("cas", "Cas Visser"),
      link("dee", "Dee Koch", { fresh: false }),
      link("eli", "Eli Maas", { path: null, fresh: false }),
    ]);
    await shown(fake);
    const before = namesOf("Links", 1);

    await chosen("Ada Lund", "Mark as sent");

    expect({
      before,
      out: groupText("Links").includes("3 of 4 links are out."),
      needs: wordsOf(found("ul", "What needs you")).includes("2 links to send"),
      asked: fake.asked,
      after: namesOf("Links", 1),
    }).toStrictEqual({
      before: ["Ada Lund", "Cas Visser"],
      out: true,
      needs: false,
      asked: ["taken ada"],
      after: ["Cas Visser"],
    });
  });

  it("marks the links ticked as sent in one press", async () => {
    const fake = byHand([
      link("ada", "Ada Lund"),
      link("cas", "Cas Visser"),
      link("fay", "Fay Smit"),
    ]);
    await shown(fake);
    const before = hasButton("Mark selected as sent");

    await click(tickOf("Choose Ada Lund"));
    await click(tickOf("Choose Fay Smit"));
    await click(found("button", "Mark selected as sent"));

    expect({
      before,
      asked: fake.asked,
      after: namesOf("Links", 1),
    }).toStrictEqual({
      before: false,
      asked: ["taken ada,fay"],
      after: ["Cas Visser"],
    });
  });

  it("pages the links past 25 of them", async () => {
    await shown(byHand(manyLinks(40)));
    const first = namesOf("Links", 1);
    const pages = document.querySelector('nav[aria-label="Pages of links"]');

    expect({
      first: first.length,
      last: first.at(-1),
      pages: pages !== null,
    }).toStrictEqual({ first: 25, last: "Person 24", pages: true });
  });

  it("shows no pages for a short list of links", async () => {
    await shown(byHand(manyLinks(3)));

    expect({
      rows: namesOf("Links", 1).length,
      pages: document.querySelector('nav[aria-label="Pages of links"]'),
    }).toStrictEqual({ rows: 3, pages: null });
  });

  it("says that every invitation was delivered, in place of an empty table, where Grasp emails the links and none failed", async () => {
    await shown(
      fakeOf({
        campaign: { ...campaign, asks: [] },
        links: [link("ada", "Ada Lund")],
      })
    );
    const all = namesOf("Links");

    await click(found("button", "Needs attention"));

    expect({
      all,
      calm: groupText("Links").includes("Every invitation was delivered."),
      table: document.querySelector('table[aria-label="Links"]'),
    }).toStrictEqual({ all: ["Ada Lund"], calm: true, table: null });
  });

  it("shows the plan's facts and the way to the campaign page", async () => {
    await shown(fakeOf());
    const activity = groupText("Activity");

    expect({
      first: activity.includes("First dayNov 23, 2026"),
      last: activity.includes("Last dayNov 27, 2026"),
      links: activity.includes("LinksEmailed by Grasp, from mail.grasp.test"),
      reminder: activity.includes("Grasp’s reminderOnce, after 3 working days"),
      way: found("a", "Open the campaign page").getAttribute("href"),
    }).toStrictEqual({
      first: true,
      last: true,
      links: true,
      reminder: true,
      way: "/setup?step=listening",
    });
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
