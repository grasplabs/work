import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";

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

type Catalog = () => Promise<{ messages: Messages }>;

/**
 * Each language's catalog, whole, and its lean part: what the lean pages
 * (lean-pages.ts) say, which the build works out (lean-parts.ts). Out of a
 * build the lean part is the whole.
 */
const catalogs: Record<Locale, { lean: Catalog; whole: Catalog }> = {
  en: {
    lean: async () => await import("./locales/en/messages.po?lean"),
    whole: async () => await import("./locales/en/messages.po"),
  },
  de: {
    lean: async () => await import("./locales/de/messages.po?lean"),
    whole: async () => await import("./locales/de/messages.po"),
  },
  nl: {
    lean: async () => await import("./locales/nl/messages.po?lean"),
    whole: async () => await import("./locales/nl/messages.po"),
  },
  es: {
    lean: async () => await import("./locales/es/messages.po?lean"),
    whole: async () => await import("./locales/es/messages.po"),
  },
  fr: {
    lean: async () => await import("./locales/fr/messages.po?lean"),
    whole: async () => await import("./locales/fr/messages.po"),
  },
};

/** Whether the page needs every message, not only the lean pages' own. */
let whole = true;

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
  const part = whole ? "whole" : "lean";
  let { messages } = await catalogs[locale][part]();
  if (part === "lean" && whole) {
    // The whole catalog, asked for while the lean part came, joins it.
    const rest = await catalogs[locale].whole();
    messages = { ...messages, ...rest.messages };
  }
  i18n.loadAndActivate({ locale, messages });
  // Screen readers, hyphenation and spell checking follow the page's language.
  document.documentElement.lang = locale;
};

/**
 * Before the first render: the person's choice, else the browser's
 * language, else English. A language that fails to load falls back to
 * English, so the page still says something. A lean page loads only the
 * lean part of it.
 */
export const startI18n = async ({ lean }: { lean: boolean }): Promise<void> => {
  whole = !lean;
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
  whole = true;
  const { locale } = i18n;
  if (isLocale(locale)) {
    const { messages } = await catalogs[locale].whole();
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
