import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";

import type { Part } from "./lean-pages.ts";
import { localeCookie, pickLocale } from "./locale-choice.ts";

// The languages the frontend speaks: English is written in the code, the
// others are catalogs in `locales/<locale>/messages.po` (lingui.config.ts).
// Each is named in its own words, so anyone can find theirs.

export const localeNames = {
  en: "English",
  de: "Deutsch",
  nl: "Nederlands",
  es: "Español",
  fr: "Français",
} as const;

export type Locale = keyof typeof localeNames;

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && Object.hasOwn(localeNames, value);

const aYear = 365 * 24 * 60 * 60 * 1000;

type Catalogs = Record<string, () => Promise<{ messages: Messages }>>;

/**
 * Each language's catalog, whole, and each lean page's part of it
 * (lean-pages.ts): what that page says, which the build works out
 * (lean-parts.ts). Out of a build a part is the whole.
 */
const catalogs: Record<Part, Catalogs> = {
  whole: import.meta.glob<{ messages: Messages }>("./locales/*/messages.po"),
  interview: import.meta.glob<{ messages: Messages }>(
    "./locales/*/messages.po",
    {
      query: "?lean=interview",
    }
  ),
  setup: import.meta.glob<{ messages: Messages }>("./locales/*/messages.po", {
    query: "?lean=setup",
  }),
};

const catalog = async (
  locale: Locale,
  part: Part
): Promise<{ messages: Messages }> => {
  const load = catalogs[part][`./locales/${locale}/messages.po`];
  if (load === undefined) {
    throw new Error(`No ${locale} catalog`);
  }
  return await load();
};

/** What the page needs of each catalog: a lean page's part, or the whole. */
let needed: Part = "whole";

/** The language the person chose in this browser, if they did. */
const chosenLocale = async (): Promise<string | undefined> => {
  try {
    const cookie = await cookieStore.get(localeCookie);
    return cookie?.value;
  } catch {
    // Without the Cookie Store API (an older browser), nothing was kept.
    return undefined;
  }
};

/** Loads a language and switches every message to it. */
const activate = async (locale: Locale): Promise<void> => {
  const part = needed;
  let { messages } = await catalog(locale, part);
  if (part !== needed) {
    // The whole catalog, asked for while the lean part came, joins it.
    const rest = await catalog(locale, needed);
    messages = { ...messages, ...rest.messages };
  }
  i18n.loadAndActivate({ locale, messages });
  // Screen readers, hyphenation and spell checking follow the page's language.
  document.documentElement.lang = locale;
};

/**
 * Before the first render: the person's choice, else the browser's
 * language, else English. A language that fails to load falls back to
 * English, so the page still says something. A lean page loads only its
 * own part of it.
 */
export const startI18n = async (part: Part): Promise<void> => {
  needed = part;
  const picked = pickLocale(
    await chosenLocale(),
    navigator.languages,
    Object.keys(localeNames)
  );
  const locale = isLocale(picked) ? picked : "en";
  try {
    await activate(locale);
  } catch (error) {
    if (locale === "en") {
      throw error;
    }
    await activate("en");
  }
};

/** Switches to `locale` and keeps the choice in this browser for a year. */
export const chooseLocale = async (locale: Locale): Promise<void> => {
  await activate(locale);
  try {
    await cookieStore.set({
      name: localeCookie,
      value: locale,
      path: "/",
      sameSite: "lax",
      expires: Date.now() + aYear,
    });
  } catch {
    // Without the Cookie Store API the choice lasts until the page reloads.
  }
};

const addWholeCatalog = async (): Promise<void> => {
  needed = "whole";
  const { locale } = i18n;
  if (isLocale(locale)) {
    const { messages } = await catalog(locale, "whole");
    i18n.load(locale, messages);
  }
};

let wholeCatalog: Promise<void> | undefined;

/**
 * Adds the rest of the language's messages, once, as a lean page leads
 * anywhere else (page-parts.ts). Nothing on the page changes: what it says
 * is in the lean part already.
 */
export const loadWholeCatalog = async (): Promise<void> => {
  wholeCatalog ??= addWholeCatalog();
  try {
    await wholeCatalog;
  } catch (error) {
    // Asked again, it tries again.
    wholeCatalog = undefined;
    throw error;
  }
};
