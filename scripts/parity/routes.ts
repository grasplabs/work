/**
 * The pages `vp run parity` compares (run.ts): each prototype route at
 * the pinned commit with the Grasp OS route that ports it. A page whose
 * address takes an ID (a workflow, a note, an app) joins once the seed
 * gives both apps the same one; until then the list holds the pages both
 * reach by a fixed address.
 */

/** The prototype commit the pages are compared against (GRA-493). */
export const prototypeCommit = "ddd235d4";

/** One page in both apps: its name in the report, and each app's path. */
export interface ParityRoute {
  /** A file-name-safe name, as the report and its screenshots use it. */
  readonly name: string;
  /** The path in the prototype (`packages/grasp/src/routes`). */
  readonly prototype: string;
  /** The path in Grasp OS (`apps/web/src/routes`). */
  readonly grasp: string;
  /** Who Grasp OS is taken as: the company's admin unless said. */
  readonly session?: ParitySession;
}

/**
 * Who a Grasp OS page is taken as: the seed's admin, or the stack's Grasp
 * staff member for a page only staff reach (the onboarding area).
 */
export type ParitySession = "admin" | "staff";

/** Every page compared, in the order the sidebar has them. */
export const parityRoutes: readonly ParityRoute[] = [
  { name: "chat", prototype: "/", grasp: "/" },
  { name: "dashboard", prototype: "/dashboard", grasp: "/dashboard" },
  { name: "inbox", prototype: "/inbox", grasp: "/inbox" },
  { name: "apps", prototype: "/apps", grasp: "/apps" },
  { name: "workflows", prototype: "/workflows", grasp: "/workflows" },
  { name: "domains", prototype: "/domains", grasp: "/domains" },
  { name: "brain", prototype: "/brain", grasp: "/brain" },
  { name: "integrations", prototype: "/integrations", grasp: "/integrations" },
  { name: "landscape", prototype: "/landscape", grasp: "/landscape" },
  { name: "policies", prototype: "/policies", grasp: "/policies" },
  {
    name: "onboarding",
    prototype: "/onboarding",
    grasp: "/onboarding",
    session: "staff",
  },
  { name: "settings", prototype: "/settings", grasp: "/settings" },
  {
    name: "settings-profile",
    prototype: "/settings/profile",
    grasp: "/settings/profile",
  },
  {
    name: "settings-workspace",
    prototype: "/settings/workspace",
    grasp: "/settings/workspace",
  },
  {
    name: "settings-members",
    prototype: "/settings/members",
    grasp: "/settings/members",
  },
  {
    name: "settings-models",
    prototype: "/settings/models",
    grasp: "/settings/models",
  },
  {
    name: "settings-notifications",
    prototype: "/settings/notifications",
    grasp: "/settings/notifications",
  },
  {
    name: "settings-security",
    prototype: "/settings/security",
    grasp: "/settings/security",
  },
  {
    name: "settings-spend",
    prototype: "/settings/spend",
    grasp: "/settings/spend",
  },
  {
    name: "settings-audit",
    prototype: "/settings/audit",
    grasp: "/settings/audit",
  },
  {
    name: "settings-billing",
    prototype: "/settings/billing",
    grasp: "/settings/billing",
  },
  {
    name: "settings-pulse",
    prototype: "/settings/pulse",
    grasp: "/settings/pulse",
  },
];

/** The widths each page is taken at, in CSS pixels: a desktop and a phone. */
export const parityWidths = [1440, 390] as const;

/** The themes each page is taken in, as the browser asks for them. */
export const parityThemes = ["light", "dark"] as const;

export type ParityWidth = (typeof parityWidths)[number];
export type ParityTheme = (typeof parityThemes)[number];
