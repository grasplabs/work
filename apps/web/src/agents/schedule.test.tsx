// @vitest-environment happy-dom

import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { messages as german } from "../locales/de/messages.po";
import { messages as spanish } from "../locales/es/messages.po";
import { messages as french } from "../locales/fr/messages.po";
import { messages as dutch } from "../locales/nl/messages.po";
import {
  cronOfSchedule,
  rhythms,
  scheduleOfCron,
  scheduleOfRhythm,
  useScheduleWords,
} from "./schedule.ts";
import type { Schedule } from "./schedule.ts";

// Every schedule the pages can write, read back as core keeps it and said
// in words. These start from the ways it can fail: a schedule written in
// a form the reader doesn't know, and shown as cron; one read back as
// another than was picked; a language that says it in English or as cron.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const catalogs: Record<string, Messages> = {
  en: {},
  de: german,
  nl: dutch,
  es: spanish,
  fr: french,
};

/** Each of `crons` in words in `locale`, as a page shows them. */
const saidIn = async (
  locale: string,
  crons: readonly string[]
): Promise<string[]> => {
  i18n.loadAndActivate({ locale, messages: catalogs[locale] ?? {} });
  const Said = () => {
    const { ofCron } = useScheduleWords();
    return (
      <ul>
        {crons.map((cron) => (
          <li key={cron}>{ofCron(cron)}</li>
        ))}
      </ul>
    );
  };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <I18nProvider i18n={i18n}>
        <Said />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return [...host.querySelectorAll("li")].map((each) => each.textContent);
};

/** Every non-empty set of weekdays, 0 for Sunday. */
const daySets = Array.from({ length: 127 }, (_, at) =>
  [0, 1, 2, 3, 4, 5, 6].filter(
    (day) => Math.floor((at + 1) / 2 ** day) % 2 === 1
  )
);
const halfHours = Array.from({ length: 48 }, (_, at) => {
  const hour = String(Math.floor(at / 2)).padStart(2, "0");
  return `${hour}:${at % 2 === 0 ? "00" : "30"}`;
});

/** Every schedule the guided setup offers, at `time`. */
const offered = (time: string): Schedule[] => [
  { frequency: "daily", days: new Set(), dayOfMonth: 1, time },
  ...daySets.map((days): Schedule => ({
    frequency: "weekly",
    days: new Set(days),
    dayOfMonth: 1,
    time,
  })),
  ...Array.from({ length: 28 }, (_, at): Schedule => ({
    frequency: "monthly",
    days: new Set(),
    dayOfMonth: at + 1,
    time,
  })),
];

/**
 * What a schedule says, to compare: how often, its days, its day of the
 * month and its time; every day of the week, picked one by one, is every day.
 */
const keyOf = (schedule: Schedule): string => {
  const daily =
    schedule.frequency === "daily" ||
    (schedule.frequency === "weekly" && schedule.days.size === 7);
  if (daily) {
    return `daily ${schedule.time}`;
  }
  if (schedule.frequency === "monthly") {
    return `monthly ${String(schedule.dayOfMonth)} ${schedule.time}`;
  }
  const days = [...schedule.days].toSorted((a, b) => a - b).join(",");
  return `${schedule.frequency} ${days} ${schedule.time}`;
};

/** Every schedule the chat and Add a time offer, at every time. */
const quick = halfHours.flatMap((time) =>
  rhythms.map((rhythm) => scheduleOfRhythm(rhythm, time))
);

describe("an agent's schedule, written and read back", () => {
  afterEach(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
    document.body.replaceChildren();
  });

  it("reads back every schedule the pages write as the one written", () => {
    const written = [...halfHours.flatMap((time) => offered(time)), ...quick];
    const misread = written.filter((schedule) => {
      const cron = cronOfSchedule(schedule);
      const read = cron === undefined ? undefined : scheduleOfCron(cron);
      return read === undefined || keyOf(read) !== keyOf(schedule);
    });
    expect({ written: written.length, misread }).toStrictEqual({
      written: 48 * (1 + 127 + 28) + 48 * rhythms.length,
      misread: [],
    });
  });

  it("says every one of them in words in each language, never as cron, and in that language", async () => {
    const samples = [
      ...new Set(
        [
          ...offered("09:00"),
          ...offered("17:30").slice(0, 2),
          ...quick,
        ].flatMap((schedule) => cronOfSchedule(schedule) ?? [])
      ),
    ];
    const english = await saidIn("en", samples);
    const said: Record<string, { cron: number; english: number }> = {};
    for (const locale of Object.keys(catalogs)) {
      // oxlint-disable-next-line no-await-in-loop -- one language at a time
      const words = await saidIn(locale, samples);
      said[locale] = {
        cron: words.filter((each, at) => each === samples[at]).length,
        english:
          locale === "en"
            ? 0
            : words.filter((each, at) => each === english[at]).length,
      };
    }
    expect(said).toStrictEqual({
      en: { cron: 0, english: 0 },
      de: { cron: 0, english: 0 },
      nl: { cron: 0, english: 0 },
      es: { cron: 0, english: 0 },
      fr: { cron: 0, english: 0 },
    });
  });

  it("says each kind as a person would, and core's short forms the same", async () => {
    await expect(
      saidIn("en", [
        "0 9 * * 1,2,3,4,5",
        "0 9 * * 1-5",
        "30 7 * * 1",
        "0 9 * * 1,5",
        "0 9 * * 0,6",
        "0 9 * * *",
        "0 9 1 * *",
        "0 9 * * 0-6",
      ])
    ).resolves.toStrictEqual([
      "Every weekday at 9:00 AM",
      "Every weekday at 9:00 AM",
      "Every Monday at 7:30 AM",
      "Every Monday and Friday at 9:00 AM",
      "Every Saturday and Sunday at 9:00 AM",
      "Every day at 9:00 AM",
      "Day 1 of every month at 9:00 AM",
      "Every day at 9:00 AM",
    ]);
  });

  it("is none of ours when it was made another way, and shown as core keeps it", async () => {
    const others = [
      "0 */2 * * *",
      "0 9 1 * 1",
      "0 9 * 1 *",
      "61 9 * * *",
      "0 24 * * *",
      "0 9 * * 8",
      "nonsense",
    ];
    expect({
      read: others.filter((cron) => scheduleOfCron(cron) !== undefined),
      shown: await saidIn("en", others),
    }).toStrictEqual({ read: [], shown: others });
  });

  it("writes no schedule for a time that isn't one, or a week with no day", () => {
    expect([
      cronOfSchedule(scheduleOfRhythm("daily", "")),
      cronOfSchedule(scheduleOfRhythm("daily", "24:00")),
      cronOfSchedule(scheduleOfRhythm("daily", "9:00")),
      cronOfSchedule({
        frequency: "weekly",
        days: new Set(),
        dayOfMonth: 1,
        time: "09:00",
      }),
      cronOfSchedule({
        frequency: "asked",
        days: new Set(),
        dayOfMonth: 1,
        time: "09:00",
      }),
    ]).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
