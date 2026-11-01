/**
 * The apps the companies asked Grasp to add, as Composio's catalog doesn't have them: one per app
 * across every company, with which companies asked and when. Only what the admin reads of them is
 * here. Pure.
 */

/** One company's request for an app: the organization, by its id in the admin, and the day it asked. */
export interface AppRequest {
  org: string;
  on: string;
}

/** An app asked of Grasp, by however many companies. */
export interface AskedApp {
  /** An id that says nothing a company wrote. */
  id: string;
  /** Its name, as the first company to ask for it wrote it. */
  app: string;
  requests: AppRequest[];
}

/** The organizations that asked for the app, once each, in the order they asked. */
export const askedBy = (app: AskedApp): string[] => [
  ...new Set(
    app.requests
      .toSorted((a, b) => a.on.localeCompare(b.on))
      .map((request) => request.org)
  ),
];

/** The day the app was first asked for. */
export const firstAsked = (app: AskedApp): string =>
  app.requests.map((request) => request.on).toSorted()[0] ?? "";

/** The app most companies asked for first, then the one asked for longest ago. */
export const sortAsked = (apps: readonly AskedApp[]): AskedApp[] =>
  apps.toSorted(
    (a, b) =>
      askedBy(b).length - askedBy(a).length ||
      firstAsked(a).localeCompare(firstAsked(b)) ||
      a.app.localeCompare(b.app)
  );
