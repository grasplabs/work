import { i18n } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";

import { formatDate, formatList } from "../format.ts";
import type { Tone } from "./insight.tsx";
import type { AppTab } from "./landscape-app.ts";
import {
  aiTypeDescription,
  aiTypeLabel,
  appSourceDescription,
  appSourceLabel,
} from "./landscape.ts";
import type { LandscapeApp } from "./landscape.ts";

// An app's Overview, as the prototype builds it (`lib/landscape-overview.ts`):
// its profile, in two columns. The prototype fills it from its V1 demo
// data, with the evidence Grasp read in the vendor's documents; Grasp
// keeps neither yet, so a fact nothing records says so ("Not known",
// "Not disclosed"), and only what Grasp knows (its AI type as far as it is
// classified, when it was first seen and how) opens what it means.

/** Where the data residency section sits on the Data tab. */
export const dataSection = {
  residency: "data-section-residency",
  permissions: "data-section-permissions",
} as const;

/** What Grasp read about a value, as plain text: the Overview renders it in an insight popover. */
export interface InsightText {
  label: string;
  summary: string;
  confidence?: "high" | "medium" | "low";
}

/** Where on the app page something leads: a tab, and optionally a section on it. */
export interface AppTarget {
  tab: AppTab;
  hash?: string;
}

export type ProfileKey =
  | "vendor"
  | "domain"
  | "aiType"
  | "hosting"
  | "training"
  | "retention"
  | "owner"
  | "firstSeen"
  | "sources"
  | "dpa"
  | "certifications"
  | "deletion";

/** One line of the app profile. The Overview picks the icon from the key. */
export interface ProfileFact {
  key: ProfileKey;
  label: string;
  value: string;
  /** A dot before the value, when the value is a signal. */
  tone?: Tone;
  insight?: InsightText;
  /** Where the value is worked on inside the app page. */
  target?: AppTarget;
  /** The person the value names, shown with their initials. */
  person?: string;
}

/** The profile in its two columns: the vendor and its data on the left, governance on the right. */
export interface AppProfile {
  left: ProfileFact[];
  right: ProfileFact[];
}

const dayMs = 24 * 60 * 60 * 1000;

/** Whole days from `iso` to `now`; none for a time that isn't one. */
const daysSince = (iso: string, now: Date): number | null => {
  const time = new Date(iso).getTime();
  return Number.isFinite(time)
    ? Math.max(0, Math.round((now.getTime() - time) / dayMs))
    : null;
};

/** What the vendor's documents would say, which Grasp keeps none of yet. */
const notConfirmed = msg({
  message: "Not confirmed",
  context: "model training, retention or deletion",
});

/**
 * The app profile: vendor, domain, AI type, data hosting, model training
 * and retention on the left; owner, first seen, discovery sources, DPA,
 * certifications and right to deletion on the right.
 */
export const appProfile = (
  app: LandscapeApp,
  now: Date = new Date()
): AppProfile => {
  const { name } = app;
  const aiTypeText = t`AI type`;
  const firstSeenLabel = t`First seen`;
  const sourcesLabel = t`Discovery sources`;
  const days = daysSince(app.firstSeen, now);
  const firstSeen = days === null ? t`Not recorded` : formatDate(app.firstSeen);
  const sources = app.use.sources.map((source) =>
    i18n._(appSourceLabel[source])
  );

  const left: ProfileFact[] = [
    { key: "vendor", label: t`Vendor`, value: app.vendor ?? t`Not known` },
    { key: "domain", label: t`Domain`, value: t`Not known` },
    {
      key: "aiType",
      label: aiTypeText,
      value: i18n._(aiTypeLabel[app.aiType]),
      insight: {
        label: aiTypeText,
        summary: i18n._(aiTypeDescription[app.aiType]),
      },
    },
    {
      key: "hosting",
      label: t`Data hosting`,
      value: t`Not disclosed`,
      target: { tab: "data", hash: dataSection.residency },
    },
    { key: "training", label: t`Model training`, value: i18n._(notConfirmed) },
    {
      key: "retention",
      label: t`Retention period`,
      value: i18n._(notConfirmed),
    },
  ];

  const right: ProfileFact[] = [
    app.owner === null
      ? {
          key: "owner",
          label: t`Owner`,
          value: t`Needs assignment`,
          tone: "attention",
        }
      : { key: "owner", label: t`Owner`, value: app.owner, person: app.owner },
    days === null
      ? { key: "firstSeen", label: firstSeenLabel, value: firstSeen }
      : {
          key: "firstSeen",
          label: firstSeenLabel,
          value: firstSeen,
          insight: {
            label: firstSeenLabel,
            summary:
              days > 30
                ? t`${name} was first seen on ${firstSeen}, more than a month ago.`
                : t`${name} was first seen on ${firstSeen}, less than a month ago.`,
            confidence: "high",
          },
        },
    {
      key: "sources",
      label: sourcesLabel,
      value: sources.length === 0 ? t`Not known` : formatList(sources),
      insight:
        app.use.sources.length === 0
          ? undefined
          : {
              label: sourcesLabel,
              summary: app.use.sources
                .map((source) => i18n._(appSourceDescription[source]))
                .join(" "),
              confidence: "high",
            },
    },
    { key: "dpa", label: t`DPA status`, value: t`Not recorded` },
    {
      key: "certifications",
      label: t`Certifications`,
      value: t`None on file`,
    },
    {
      key: "deletion",
      label: t`Right to deletion`,
      value: i18n._(notConfirmed),
    },
  ];

  return { left, right };
};
