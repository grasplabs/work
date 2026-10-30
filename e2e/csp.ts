import { expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { test as base } from "./contexts.ts";

declare global {
  interface Window {
    /** Exposed by Playwright to the page, see below. */
    reportCspViolation: (violation: string) => Promise<void>;
  }
}

/**
 * Collects every Content Security Policy violation on `page`, from the
 * `securitypolicyviolation` event and from the browser's console. The event
 * reaches the document only from elements in it and from what its scripts
 * evaluate (`eval`, `new Function`); the console reports more.
 */
export const recordCspViolations = async (page: Page): Promise<string[]> => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content[ -]security[ -]policy/iu.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.exposeFunction("reportCspViolation", (violation: string) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void window.reportCspViolation(
        `${event.effectiveDirective} blocked ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`
      );
    });
  });
  return violations;
};

/**
 * Adds to `violations` what violates the product page's own policy on
 * every page of `context`, from the `securitypolicyviolation` event of each
 * page's top document. Not its screens' frames: they have a policy of their
 * own, which journeys break on purpose to show that it holds.
 */
const watchProductPages = async (
  context: BrowserContext,
  violations: string[]
): Promise<void> => {
  await context.exposeFunction("reportCspViolation", (violation: string) => {
    violations.push(violation);
  });
  await context.addInitScript(() => {
    if (window !== window.top) {
      return;
    }
    document.addEventListener("securitypolicyviolation", (event) => {
      void window.reportCspViolation(
        `${event.effectiveDirective} blocked ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`
      );
    });
  });
};

/**
 * The tests' `test` (contexts.ts), failing any test that violates the
 * app's CSP: on its own `page`, and on the product pages of the browser
 * contexts it opens (`newContext`, `pageOf`), where most journeys sign in. An
 * `eval` the policy refuses counts too, caught or not: Zod probes for one
 * unless it is jitless (apps/web/public/theme.js).
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations = await recordCspViolations(page);
      await use(violations);
      expect(violations).toStrictEqual([]);
    },
    { auto: true },
  ],
  newContext: async ({ newContext, cspViolations }, provide) => {
    await provide(async (options) => {
      const context = await newContext(options);
      await watchProductPages(context, cspViolations);
      return context;
    });
  },
});
