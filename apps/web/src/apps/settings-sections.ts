import type { ViewedApp } from "@grasp-os/shared/apps";
import type { SurfaceSummary } from "@grasp-os/shared/pages";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { Session } from "../core.ts";
import type { Loaded } from "../load-from-core.tsx";

// An App's settings sections on their own: the App's sidebar section and
// its address (the routes' validateSearch) come with the app, its settings
// page (app-settings.tsx) doesn't.

/** The sections, in the order the list shows them. */
export const appSettingsSections = [
  "general",
  "sharing",
  "history",
  "connections",
  "webhooks",
  "options",
] as const;

export type AppSettingsSection = (typeof appSettingsSections)[number];

/** A section named in an address, or none for anything else. */
export const settingsSectionOf = (
  value: unknown
): AppSettingsSection | undefined =>
  appSettingsSections.find((section) => section === value);

export const sectionLabels: Record<AppSettingsSection, MessageDescriptor> = {
  general: msg({ message: "General", context: "an app's settings section" }),
  sharing: msg({ message: "Sharing", context: "an app's settings section" }),
  history: msg({ message: "History", context: "an app's settings section" }),
  connections: msg({
    message: "Connections",
    context: "an app's settings section",
  }),
  webhooks: msg({ message: "Webhooks", context: "an app's settings section" }),
  options: msg({
    message: "Options",
    context: "the settings an app offers itself",
  }),
};

export const readSurfaces = async (session: Session, app: string) =>
  await session.pages.surfaces(app);

/** The App's settings surface (spec 34.1), if it declares one. */
export const optionsOf = (
  surfaces: Loaded<SurfaceSummary[]> | undefined
): SurfaceSummary | undefined =>
  surfaces?.state === "ready"
    ? surfaces.data.find(({ kind }) => kind === "settings")
    : undefined;

/** The sections `identity` sees of `app`, with Options once core says it declares them. */
export const shownSections = (
  app: ViewedApp,
  identity: Identity,
  { options }: { options: boolean }
): AppSettingsSection[] => {
  const builder = app.role === "builder";
  const shown: Record<AppSettingsSection, boolean> = {
    general: true,
    sharing: true,
    // Core lists versions and webhooks to its builders alone.
    history: builder,
    connections: canBuild(identity.role),
    webhooks: builder,
    options,
  };
  return appSettingsSections.filter((section) => shown[section]);
};
