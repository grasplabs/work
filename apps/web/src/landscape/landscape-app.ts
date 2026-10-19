import { msg } from "@lingui/core/macro";

// The tabs of an app's page, as the prototype has them (`lib/landscape-app.ts`).

/** The tabs of an app page, in order, with where each leads. */
export const appTabs = [
  {
    label: msg({ message: "Overview", context: "tab of an app page" }),
    segment: "overview",
    to: "/landscape/$appId/overview",
  },
  {
    label: msg({ message: "Data", context: "tab of an app page" }),
    segment: "data",
    to: "/landscape/$appId/data",
  },
  {
    label: msg({ message: "Connections", context: "tab of an app page" }),
    segment: "connections",
    to: "/landscape/$appId/connections",
  },
  {
    label: msg({ message: "Usage", context: "tab of an app page" }),
    segment: "usage",
    to: "/landscape/$appId/usage",
  },
  {
    label: msg({ message: "Audit trail", context: "tab of an app page" }),
    segment: "audit",
    to: "/landscape/$appId/audit",
  },
] as const;

export type AppTab = (typeof appTabs)[number]["segment"];

/** The tab a path is on; the Overview when it names none. */
export const tabOf = (pathname: string, appId: string): AppTab => {
  // The address carries the ID encoded (`native%3Amicrosoft`), or as it is.
  const after =
    pathname.split(`/landscape/${encodeURIComponent(appId)}/`)[1] ??
    pathname.split(`/landscape/${appId}/`)[1];
  const segment = after?.split("/")[0];
  return appTabs.find((tab) => tab.segment === segment)?.segment ?? "overview";
};
