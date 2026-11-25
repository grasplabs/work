// @vitest-environment happy-dom
import { dayOf } from "@grasp-os/shared/admin/org-record";
import type { OnboardingView, PlanInput } from "@grasp-os/shared/onboarding";
import { noChoices } from "@grasp-os/shared/onboarding-choices";
import { noContext } from "@grasp-os/shared/onboarding-context";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { datePattern, parseDate } from "@ui-sdk/react/date";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { dateLocale } from "./date-locale.ts";
import { firstChoice, todayInUtc } from "./send-plan.ts";
import { SetupStepBody } from "./setup-steps.tsx";
import type { SetupData } from "./setup-steps.tsx";
import { steps } from "./setup.ts";
import type { SetupStep } from "./setup.ts";
import { planDraft } from "./visit.ts";

// The team step's plan, as a person in a region of their own types its
// day: read in their order, or refused in words, and what "What happens
// next" says is what core is asked to save, on any clock; and the leads
// and team steps' confirmations, pressed once. Core's answer is faked.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A Monday: the first links go out tomorrow, Tuesday 24 November. */
const today = "2026-11-23";

/** The year the picker's example is in: this one, on the clock the test runs by. */
const thisYear = new Date().getFullYear();

const view: OnboardingView = {
  roster: {
    teams: [
      { id: "sales", name: "Sales", lead: "ana", does: "", off: false },
      { id: "ops", name: "Ops", lead: "bo", does: "", off: false },
    ],
    people: [
      {
        id: "ana",
        name: "Ana",
        email: "ana@acme.test",
        team: "sales",
        title: "",
        away: false,
      },
      {
        id: "bo",
        name: "Bo",
        email: "bo@acme.test",
        team: "ops",
        title: "",
        away: false,
      },
    ],
  },
  plan: null,
  progress: null,
  agreed: true,
  paused: false,
  kickoff: null,
  teamsInBrain: null,
  sponsor: null,
  context: noContext,
  waiting: 0,
  mailSends: true,
  mailDomain: "mail.example.test",
};

const data: SetupData = {
  admin: "Ada",
  company: null,
  view,
  links: [],
  documents: [],
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
  choices: noChoices,
  signIn: ["microsoft"],
  ai: null,
  identity: {
    userId: "ada",
    email: "ada@acme.test",
    name: "Ada",
    role: "admin",
    teams: [],
    staff: false,
    expiresAt: "2026-11-24T00:00:00Z",
  },
};

let root: Root | undefined;

/** The browser's own languages, as the page reads them. */
const browserIn = (languages: string[]): void => {
  Object.defineProperty(navigator, "languages", {
    configurable: true,
    get: () => languages,
  });
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

/**
 * The team step (or `step`), on a page in `language` in a browser set to
 * `browser`, showing `given`; what core is asked to save, and how often the
 * leads are confirmed. Read again after a change, core answers once
 * `reread` settles.
 */
const shown = async (
  language: string,
  browser: string[],
  {
    step = "team",
    given = data,
    reread,
    on = today,
  }: {
    step?: Exclude<SetupStep, "pulse" | "listening">;
    given?: SetupData;
    reread?: Promise<unknown>;
    on?: string;
  } = {}
): Promise<{ saved: PlanInput[]; confirmed: () => number }> => {
  i18n.loadAndActivate({ locale: language, messages: {} });
  browserIn(browser);
  const saved: PlanInput[] = [];
  let confirms = 0;
  let loads = 0;
  const core = {
    withSession: async <T,>(
      action: (session: {
        onboarding: {
          savePlan: (plan: PlanInput) => Promise<OnboardingView>;
          confirmRoster: () => Promise<OnboardingView>;
        };
      }) => Promise<T>
    ): Promise<T> =>
      await action({
        onboarding: {
          savePlan: async (plan) => {
            saved.push(plan);
            return await Promise.resolve(view);
          },
          confirmRoster: async () => {
            confirms += 1;
            return await Promise.resolve(view);
          },
        },
      }),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      loader: async () => {
        loads += 1;
        if (loads > 1) {
          await reread;
        }
      },
      component: () => (
        <SetupStepBody
          data={given}
          askedFor={0}
          go={() => {}}
          message={null}
          onMessage={() => {}}
          onSettle={() => {}}
          onward={async () => {}}
          path={steps}
          settled={[]}
          step={step}
          today={on}
        />
      ),
    }),
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
  return { saved, confirmed: () => confirms };
};

/** The field named `name`. */
const field = (name: string): HTMLInputElement => {
  const found = document.querySelector(`input[aria-label="${name}"]`);
  if (!(found instanceof HTMLInputElement)) {
    throw new TypeError(`No field ${name}`);
  }
  return found;
};

/** Types `typed` into the first day's field and leaves it, as a person does. */
const typeDay = async (typed: string): Promise<void> => {
  const day = field("Another day");
  await act(async () => {
    day.focus();
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(day, typed);
    day.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    day.blur();
    day.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

const sendButton = (): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === "Continue"
  );
  if (found === undefined) {
    throw new TypeError("No Continue");
  }
  return found;
};

/** What the step says happens next, under the plan. */
const nextSaid = (): string =>
  [...document.querySelectorAll("output")]
    .map((each) => each.textContent ?? "")
    .find(
      (each) => each.startsWith("Leads get") || each.startsWith("The lead")
    ) ?? "";

const send = async (): Promise<void> => {
  await act(async () => {
    sendButton().click();
    await Promise.resolve();
  });
  await settled();
};

/** The text of the error under the first day's field, if it shows one. */
const error = (): string | undefined =>
  document.querySelector('[data-slot="field-error"]')?.textContent?.trim();

// Browsers whose first language counts in another calendar. Safari writes
// "en-SA" in the Islamic one ("22/07/1448 AH"), which the picker reads as no day.
const calendars = [["ar-SA"], ["fa-IR"], ["th-TH"], ["ja-JP-u-ca-japanese"]];
const languages = ["en", "nl", "de", "fr", "es"];

describe("the locale a day is typed in", () => {
  it("is the page's language in the browser's region, else its first language's", () => {
    expect({
      uk: dateLocale("en", ["en-GB", "en"]),
      us: dateLocale("en", ["en-US"]),
      onlyEnglish: dateLocale("en", ["en"]),
      dutchFirst: dateLocale("en", ["nl-NL", "en-US"]),
      dutchOnly: dateLocale("en", ["nl-NL"]),
      regionless: dateLocale("en", ["nl"]),
      dutch: dateLocale("nl", ["en-GB", "nl-BE"]),
      german: dateLocale("de", ["de-AT"]),
      nothing: dateLocale("fr", []),
      broken: dateLocale("es", ["not a tag", "es-MX"]),
    }).toStrictEqual({
      uk: "en-GB-u-ca-gregory-nu-latn",
      us: "en-US-u-ca-gregory-nu-latn",
      onlyEnglish: "en-US-u-ca-gregory-nu-latn",
      dutchFirst: "en-US-u-ca-gregory-nu-latn",
      dutchOnly: "en-NL-u-ca-gregory-nu-latn",
      regionless: "en-NL-u-ca-gregory-nu-latn",
      dutch: "nl-BE-u-ca-gregory-nu-latn",
      german: "de-AT-u-ca-gregory-nu-latn",
      nothing: "fr-u-ca-gregory-nu-latn",
      broken: "es-MX-u-ca-gregory-nu-latn",
    });
  });

  it.each(calendars)(
    "is Gregorian in Latin digits with %s first, and its example is read as the day it shows",
    (first) => {
      const read = languages.map((language) => {
        const locale = dateLocale(language, [first, "en-US"]);
        // Named in the locale itself: Node's own data writes "en-SA" in the Gregorian calendar, Safari's doesn't.
        const { calendar, numberingSystem } = new Intl.Locale(locale);
        const { example } = datePattern(locale);
        return { calendar, numberingSystem, day: parseDate(example, locale) };
      });
      expect(read).toStrictEqual(
        languages.map(() => ({
          calendar: "gregory",
          numberingSystem: "latn",
          day: `${thisYear}-12-31`,
        }))
      );
    }
  );
});

// Each region's own order, day first or month first, as typed and as the field writes it back.
const regions = [
  {
    language: "en",
    browser: "en-GB",
    dayFirst: "12/01/2027",
    monthFirst: "01/12/2027",
    reads: "dayFirst",
    hint: `For example 31/12/${thisYear}`,
    // As "What happens next" says it, in the page's language.
    said: "12 Jan 2027",
  },
  {
    language: "en",
    browser: "en-US",
    dayFirst: "12/01/2027",
    monthFirst: "01/12/2027",
    reads: "monthFirst",
    hint: `For example 12/31/${thisYear}`,
    // As "What happens next" says it, in the page's language.
    said: "12 Jan 2027",
  },
  {
    language: "nl",
    browser: "nl-NL",
    dayFirst: "12-01-2027",
    monthFirst: "01-12-2027",
    reads: "dayFirst",
    hint: `For example 31-12-${thisYear}`,
    // As "What happens next" says it, in the page's language.
    said: "12 jan 2027",
  },
  {
    language: "de",
    browser: "de-DE",
    dayFirst: "12.01.2027",
    monthFirst: "01.12.2027",
    reads: "dayFirst",
    hint: `For example 31.12.${thisYear}`,
    // As "What happens next" says it, in the page's language.
    said: "12. Jan. 2027",
  },
  {
    language: "fr",
    browser: "fr-FR",
    dayFirst: "12/01/2027",
    monthFirst: "01/12/2027",
    reads: "dayFirst",
    hint: `For example 31/12/${thisYear}`,
    // As "What happens next" says it, in the page's language.
    said: "12 janv. 2027",
  },
  {
    language: "es",
    browser: "es-ES",
    dayFirst: "12/01/2027",
    monthFirst: "01/12/2027",
    reads: "dayFirst",
    hint: `For example 31/12/${thisYear}`,
    // As "What happens next" says it, in the page's language.
    said: "12 ene 2027",
  },
] as const;

describe("the team step's day, typed", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    i18n.loadAndActivate({ locale: "en", messages: {} });
    // What one test chose is no draft of the next one's.
    planDraft.keep("forgotten", firstChoice(today));
  });

  it.each(regions)(
    "reads $browser's order, says the format, and saves what it says",
    async (region) => {
      const { saved } = await shown(region.language, [region.browser]);
      // Typed in a form it can't read, it says the form it reads.
      await typeDay("soon");
      expect(error()).toContain(region.hint.replace(/^For example /u, ""));
      // 12 January 2027 in this region's order; the other order is 1 December.
      await typeDay(region[region.reads]);
      const said = nextSaid();
      await send();
      expect({
        field: field("Another day").value,
        saved: saved.map((plan) => plan.start),
        said: said.includes(region.said),
      }).toStrictEqual({
        field: region[region.reads],
        saved: ["2027-01-12"],
        said: true,
      });
    }
  );

  it("takes the other order only where it is a day too: 01/12 in the UK is 1 December", async () => {
    const { saved } = await shown("en", ["en-GB"]);
    await typeDay("01/12/2026");
    expect(nextSaid()).toContain("on 1 Dec at 9:00");
    await send();
    expect(saved.map((plan) => plan.start)).toStrictEqual(["2026-12-01"]);
  });

  it("says the day it saves, its year only when it isn't this one", async () => {
    await shown("en", ["en-GB"]);
    expect(nextSaid()).toContain("on 24 Nov at 9:00");
    await typeDay("04/01/2027");
    expect(nextSaid()).toContain("on 4 Jan 2027 at 9:00");
  });

  it("refuses a day typed in another order, says why, and sends nothing until it is put right", async () => {
    const { saved } = await shown("en", ["en-US"]);
    await typeDay("31/12/2026");
    expect({
      error: error(),
      marked: field("Another day").getAttribute("aria-invalid"),
      disabled: sendButton().disabled,
      // What it would have said is still the day before, so it can't be sent with it.
      next: nextSaid().includes("on 24 Nov at 9:00"),
    }).toStrictEqual({
      error: `I can’t plan that day. Type one like 12/31/${thisYear}, from 23 Nov to 23 Nov 2028.`,
      marked: "true",
      disabled: true,
      next: true,
    });
    // Said too, by the page's one announcer, a moment after it shows.
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      setTimeout(() => {
        resolve(true);
      }, 150);
      await promise;
    });
    expect(
      document.querySelector('[data-ui-sdk-announcer=""]')?.textContent
    ).toBe(error());
    await send();
    expect(saved).toStrictEqual([]);

    await typeDay("12/31/2026");
    expect({ error: error(), disabled: sendButton().disabled }).toStrictEqual({
      error: undefined,
      disabled: false,
    });
    await send();
    expect(saved.map((plan) => plan.start)).toStrictEqual(["2026-12-31"]);
  });

  it.each(calendars)(
    "with %s first, shows an example that is taken as typed",
    async (first) => {
      const { saved } = await shown("en", [first]);
      await typeDay("soon");
      const hint = /like (?<example>\S+),/u.exec(error() ?? "")?.groups
        ?.example;
      await typeDay(hint ?? "");
      expect(error()).toBeUndefined();
      await send();
      expect(saved.map((plan) => plan.start)).toStrictEqual([
        `${thisYear}-12-31`,
      ]);
    }
  );

  it("refuses a day more than two years ahead, and says which days it takes", async () => {
    const { saved } = await shown("en", ["en-GB"]);
    await typeDay("24/11/2028");
    expect({
      error: error(),
      disabled: sendButton().disabled,
    }).toStrictEqual({
      error: `I can’t plan that day. Type one like 31/12/${thisYear}, from 23 Nov to 23 Nov 2028.`,
      disabled: true,
    });
    await typeDay("23/11/2028");
    expect(error()).toBeUndefined();
    await send();
    expect(saved.map((plan) => plan.start)).toStrictEqual(["2028-11-23"]);
  });

  it("refuses a day before today, and text that is no day at all", async () => {
    await shown("en", ["en-GB"]);
    await typeDay("20/11/2026");
    expect(sendButton().disabled).toBeTruthy();
    await typeDay("soon");
    expect(sendButton().disabled).toBeTruthy();
    await typeDay("25/11/2026");
    expect(sendButton().disabled).toBeFalsy();
  });
});

/** The step's main button, by its words (busy, it holds them for each state it can show). */
const button = (words: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((each) =>
    each.textContent?.trim().startsWith(words)
  );

const press = async (words: string): Promise<void> => {
  await act(async () => {
    button(words)?.click();
    await Promise.resolve();
  });
  await settled();
};

describe("the leads step's confirmation", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("stays busy until every step reads what core now has, so a second press confirms nothing more", async () => {
    const { promise: reread, resolve: answered } =
      Promise.withResolvers<boolean>();
    const { confirmed } = await shown("en", ["en-GB"], {
      step: "leads",
      // The HR platform was answered: the step shows the teams and their leads.
      given: { ...data, choices: { ...noChoices, hr: { kind: "none" } } },
      reread,
    });
    await press("This is right");
    expect({
      busy: button("This is right")?.getAttribute("aria-busy"),
      confirmed: confirmed(),
    }).toStrictEqual({ busy: "true", confirmed: 1 });
    await press("This is right");
    expect(confirmed()).toBe(1);
    await act(async () => {
      answered(true);
      await Promise.resolve();
    });
    await settled();
    expect({
      next: button("Continue") === undefined,
      confirmed: confirmed(),
    }).toStrictEqual({ next: false, confirmed: 1 });
  });
});

describe("the team step's confirmation", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    planDraft.keep("forgotten", firstChoice(today));
  });

  it("stays busy until every step reads what core now has, so a second press sends nothing more", async () => {
    const { promise: reread, resolve: answered } =
      Promise.withResolvers<boolean>();
    const { saved } = await shown("en", ["en-GB"], { reread });
    await press("Continue");
    expect({
      busy: button("Continue")?.getAttribute("aria-busy"),
      saved: saved.length,
    }).toStrictEqual({ busy: "true", saved: 1 });
    await press("Continue");
    expect(saved).toHaveLength(1);
    await act(async () => {
      answered(true);
      await Promise.resolve();
    });
    await settled();
    expect({
      busy: button("Continue")?.getAttribute("aria-busy") ?? null,
      saved: saved.length,
    }).toStrictEqual({ busy: null, saved: 1 });
  });
});

// Where it is already another day than in UTC, or the same one: the first
// day the field takes is one core takes, and "What happens next" says the
// day that is sent.
const clocks = [
  {
    zone: "America/Los_Angeles",
    // 17:21 on Monday 23 November there; the 24th in UTC.
    at: "2026-11-24T01:21:00Z",
    browser: "en-US",
    before: "11/23/2026",
    earliest: "11/24/2026",
    day: "2026-11-24",
    said: "on 24 Nov at 9:00",
  },
  {
    zone: "Pacific/Auckland",
    // 9:00 on Wednesday 25 November there; still the 24th in UTC.
    at: "2026-11-24T20:00:00Z",
    browser: "en-NZ",
    before: "23/11/2026",
    earliest: "24/11/2026",
    day: "2026-11-24",
    said: "on 24 Nov at 9:00",
  },
  {
    zone: "Europe/Amsterdam",
    // Midday on Monday 23 November there and in UTC.
    at: "2026-11-23T11:00:00Z",
    browser: "nl-NL",
    before: "22-11-2026",
    earliest: "23-11-2026",
    day: "2026-11-23",
    said: "on 23 Nov at 9:00",
  },
] as const;

describe("the team step's first day, on the device's clock", () => {
  const zone = process.env.TZ;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
    if (zone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = zone;
    }
    planDraft.keep("forgotten", firstChoice(today));
  });

  it.each(clocks)(
    "in $zone, is one core takes, and is said as the day sent",
    async (clock) => {
      process.env.TZ = clock.zone;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(clock.at));
      const { saved } = await shown("en", [clock.browser], {
        on: todayInUtc(),
      });
      await typeDay(clock.before);
      const refused = sendButton().disabled;
      await typeDay(clock.earliest);
      const said = nextSaid();
      await send();
      expect({
        refused,
        error: error(),
        said: said.includes(clock.said),
        saved: saved.map((plan) => plan.start),
        // Core's own rule (onboarding/rpc.ts, savePlan): no start before today in UTC.
        taken: saved.every(
          (plan) => plan.start >= dayOf(new Date().toISOString())
        ),
      }).toStrictEqual({
        refused: true,
        error: undefined,
        said: true,
        saved: [clock.day],
        taken: true,
      });
    }
  );

  // As the admin's journey types it (e2e/admin-journey.e2e.ts): a person in
  // the UK types the page's today, day first. Taken at every hour of the
  // 24th, the merge queue's 03:08 among them, wherever the device is: the
  // field's first day and the day typed are both the UTC day.
  const hours = [
    "UTC",
    "Europe/London",
    "America/Los_Angeles",
    "Pacific/Auckland",
  ].flatMap((where) =>
    Array.from({ length: 24 }, (_, hour) => ({
      zone: where,
      at: `2026-11-24T${String(hour).padStart(2, "0")}:08:00Z`,
    }))
  );

  it.each(hours)(
    "in $zone at $at, takes today typed as in the UK",
    async (clock) => {
      process.env.TZ = clock.zone;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(clock.at));
      const on = todayInUtc();
      const { saved } = await shown("en", ["en-GB"], { on });
      const [year, month, date] = on.split("-");
      await typeDay(`${date}/${month}/${year}`);
      const said = nextSaid();
      await send();
      expect({
        on,
        error: error(),
        marked: field("Another day").getAttribute("aria-invalid"),
        said: said.includes("on 24 Nov at 9:00"),
        saved: saved.map((plan) => plan.start),
      }).toStrictEqual({
        on: "2026-11-24",
        error: undefined,
        marked: null,
        said: true,
        saved: ["2026-11-24"],
      });
    }
  );
});
