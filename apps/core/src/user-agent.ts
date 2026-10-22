import type { SessionDevice } from "@grasp-os/shared/sign-in";

// What a person signed in on, from the user agent their browser sent: a
// browser and a system, so they can tell their sessions apart in Settings
// → Security. Only names Grasp knows leave core, never the user agent
// itself: it is whatever the browser, or anyone, chose to send.

/**
 * Browsers by a mark of their own, first match wins: Edge, Opera and
 * Samsung's browser also say Chrome, and Chrome also says Safari.
 */
const browsers: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//u, "Edge"],
  [/\b(?:OPR|Opera)\//u, "Opera"],
  [/\bSamsungBrowser\//u, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//u, "Firefox"],
  [/(?:Chrome|CriOS|Chromium)\//u, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//u, "Safari"],
];

/** Systems, first match wins: Android says Linux, iOS says Mac OS X. */
const systems: [RegExp, string, boolean][] = [
  [/\biPhone\b/u, "iPhone", true],
  [/\biPad\b/u, "iPad", true],
  [/\bAndroid\b/u, "Android", true],
  [/\bWindows\b/u, "Windows", false],
  [/\bCrOS\b/u, "ChromeOS", false],
  [/\bMac OS X\b|\bMacintosh\b/u, "macOS", false],
  [/\bLinux\b/u, "Linux", false],
];

const mobileMark = /\bMobile\b/u;

/** The browser and system `userAgent` names, as far as Grasp knows them. */
export const deviceOf = (userAgent: string | null): SessionDevice => {
  if (userAgent === null) {
    return { browser: null, system: null, mobile: false };
  }
  const browser =
    browsers.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const system = systems.find(([pattern]) => pattern.test(userAgent));
  return {
    browser,
    system: system?.[1] ?? null,
    mobile: system?.[2] ?? mobileMark.test(userAgent),
  };
};
