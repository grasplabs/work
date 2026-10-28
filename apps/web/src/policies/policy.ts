import type {
  AiKind,
  DataAccessKind,
  DpaState,
  ExtensionKind,
  PolicyException,
  PolicyRule,
  RequiredCertificate,
  RuleCondition,
  RuleEffect,
  RuleStatus,
  TrainingKind,
} from "@grasp-os/shared/policies";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";

import { formatList, formatOrList } from "../format.ts";
import { exposureMeta } from "../landscape/landscape.ts";
import type {
  DataExposureType,
  HostingRegion,
  LandscapeApp,
} from "../landscape/landscape.ts";

// The policy engine, as the prototype runs it (`lib/policy.ts`). A rule
// matches an app when every one of its conditions does, and each condition
// reads one fact below. What a rule then does to the app follows from its
// status: a watching rule only shows what it would do, an active one flags
// or blocks, a paused one does nothing. An exception lets one app break one
// rule until a date. Core keeps the rules, policies and exceptions
// (`session.policies`, @grasp-os/shared/policies); which apps they catch
// is worked out here, from the Landscape's facts.

export type {
  AiKind,
  PolicyBook,
  DataAccessKind,
  DpaState,
  ExtensionKind,
  PolicyDocument,
  PolicyException,
  PolicyReadingProblem,
  PolicyRule,
  RequiredCertificate,
  RuleCondition,
  RuleEffect,
  RuleField,
  RuleProposal,
  RuleStatus,
  TrainingKind,
  UncheckedRequirement,
} from "@grasp-os/shared/policies";

/** What Grasp knows about an app that a rule can check. Null is a fact Grasp does not know. */
export interface AppFacts {
  hosting: HostingRegion[];
  vendor: string | null;
  ai: AiKind | null;
  training: TrainingKind;
  data: DataExposureType[];
  /** How many use it; null while nothing measures it. */
  people: number | null;
  hasOwner: boolean;
  certificates: RequiredCertificate[];
  dpa: DpaState | null;
  access: DataAccessKind[];
  extension: ExtensionKind | null;
}

const aiKindOf = {
  Core: "tool",
  Embed: "builtIn",
  None: "none",
  Unknown: null,
} as const;

/**
 * The facts of an app. Grasp records no vendor documents yet, so it knows
 * of no certificate, processing agreement, permission or extension; and,
 * where it does not know an app's AI, nothing of its training either.
 */
export const appFacts = (app: LandscapeApp): AppFacts => ({
  hosting: app.hosting,
  vendor: app.vendor,
  ai: aiKindOf[app.aiType],
  training: "unknown",
  data: app.dataExposure ?? [],
  people: app.users,
  hasOwner: app.owner !== null,
  certificates: [],
  dpa: null,
  access: [],
  extension: null,
});

const sameVendor = (one: string, other: string) =>
  one.trim().toLocaleLowerCase() === other.trim().toLocaleLowerCase();

/** Whether more than `moreThan` use an app; never when nothing measures it. */
const usedByMoreThan = (people: number | null, moreThan: number): boolean =>
  people !== null && people > moreThan;

/**
 * Whether one condition holds for an app. What Grasp does not know never
 * matches: an app whose hosting the vendor does not state is neither inside
 * nor outside a region, and one whose use of AI is unknown is no kind of
 * AI. Two absences are facts in their own right: an app without an owner,
 * and a certificate the vendor does not declare, which counts as one it
 * lacks.
 */
export const conditionMatches = (
  condition: RuleCondition,
  facts: AppFacts
): boolean => {
  switch (condition.field) {
    case "hosting": {
      if (facts.hosting.length === 0) {
        return false;
      }
      return condition.op === "in"
        ? facts.hosting.some((region) => condition.values.includes(region))
        : facts.hosting.some((region) => !condition.values.includes(region));
    }
    case "vendor": {
      const { vendor } = facts;
      if (vendor === null) {
        return false;
      }
      const listed = condition.values.some((each) => sameVendor(each, vendor));
      return condition.op === "is" ? listed : !listed;
    }
    case "ai": {
      return facts.ai !== null && condition.values.includes(facts.ai);
    }
    case "training": {
      return condition.values.includes(facts.training);
    }
    case "data": {
      return facts.data.some((kind) => condition.values.includes(kind));
    }
    case "people": {
      return usedByMoreThan(facts.people, condition.moreThan);
    }
    case "owner": {
      return !facts.hasOwner;
    }
    case "certificate": {
      const lacks = (certificate: RequiredCertificate) =>
        !facts.certificates.includes(certificate);
      return condition.op === "lacksAll"
        ? condition.values.every(lacks)
        : condition.values.some(lacks);
    }
    case "dpa": {
      return facts.dpa !== null && condition.values.includes(facts.dpa);
    }
    case "access": {
      return facts.access.some((kind) => condition.values.includes(kind));
    }
    case "extension": {
      return (
        facts.extension !== null && condition.values.includes(facts.extension)
      );
    }
    default: {
      return condition satisfies never;
    }
  }
};

/** A rule without conditions would catch every app, so it catches none. */
export const ruleMatches = (
  rule: Pick<PolicyRule, "conditions">,
  app: LandscapeApp
): boolean => {
  if (rule.conditions.length === 0) {
    return false;
  }
  const facts = appFacts(app);
  return rule.conditions.every((condition) =>
    conditionMatches(condition, facts)
  );
};

export const matchingApps = (
  rule: Pick<PolicyRule, "conditions">,
  apps: readonly LandscapeApp[]
): LandscapeApp[] => apps.filter((app) => ruleMatches(rule, app));

/* ── Findings ────────────────────────────────────────────────────────── */

/** What a rule does to an app it matches: blocks or flags it, would do so, or lets it be for now. */
export type FindingState = "blocked" | "flagged" | "watching" | "excepted";

export interface Finding {
  rule: PolicyRule;
  app: LandscapeApp;
  state: FindingState;
  /** The exception that lets the app be, when there is one. */
  exception?: PolicyException;
}

const stateRank: Record<FindingState, number> = {
  blocked: 0,
  flagged: 1,
  watching: 2,
  excepted: 3,
};

/** An exception counts up to and including its last day. */
export const exceptionFor = (
  exceptions: readonly PolicyException[],
  ruleId: string,
  appId: string,
  today: string
): PolicyException | undefined =>
  exceptions.find(
    (each) =>
      each.ruleId === ruleId && each.appId === appId && each.until >= today
  );

const stateOf = (
  rule: PolicyRule,
  exception: PolicyException | undefined
): FindingState => {
  if (exception !== undefined) {
    return "excepted";
  }
  if (rule.status === "watching") {
    return "watching";
  }
  return rule.effect === "block" ? "blocked" : "flagged";
};

/** Every app each watching or active rule matches, the most serious first. */
export const findings = (
  rules: readonly PolicyRule[],
  apps: readonly LandscapeApp[],
  exceptions: readonly PolicyException[],
  today: string
): Finding[] =>
  rules
    .filter((rule) => rule.status !== "paused")
    .flatMap((rule) =>
      matchingApps(rule, apps).map((app) => {
        const exception = exceptionFor(exceptions, rule.id, app.id, today);
        return exception === undefined
          ? { rule, app, state: stateOf(rule, exception) }
          : { rule, app, state: stateOf(rule, exception), exception };
      })
    )
    .toSorted(
      (one, other) =>
        stateRank[one.state] - stateRank[other.state] ||
        (other.app.users ?? 0) - (one.app.users ?? 0) ||
        one.app.name.localeCompare(other.app.name)
    );

/** The findings that act on apps now: blocked or flagged by an active rule. */
export const inForce = (found: readonly Finding[]): Finding[] =>
  found.filter(({ state }) => state === "blocked" || state === "flagged");

/**
 * The landscape as the rules leave it: an app an active rule blocks is
 * blocked, one it flags is flagged, naming the rule. Nothing else marks an
 * app, so lifting a rule lifts its marks.
 */
export const applyPolicy = (
  apps: readonly LandscapeApp[],
  found: readonly Finding[]
): LandscapeApp[] => {
  const strongest = new Map<string, Finding>();
  for (const finding of inForce(found)) {
    const current = strongest.get(finding.app.id);
    if (
      current === undefined ||
      stateRank[finding.state] < stateRank[current.state]
    ) {
      strongest.set(finding.app.id, finding);
    }
  }
  return apps.map((app) => {
    const finding = strongest.get(app.id);
    return {
      ...app,
      blocked: finding?.state === "blocked",
      flagged: finding?.state === "flagged",
      policySource: finding?.rule.name ?? null,
    };
  });
};

/**
 * Everyone who uses an app a finding is about, counted once per app; null
 * when nothing measures how many use one of them, so no total is known.
 */
export const peopleAffected = (found: readonly Finding[]): number | null => {
  const apps = new Map(found.map(({ app }) => [app.id, app.users]));
  let sum = 0;
  for (const users of apps.values()) {
    if (users === null) {
      return null;
    }
    sum += users;
  }
  return sum;
};

/** How many apps a rule catches, in the words of what it does to them. */
export const caughtText = (
  rule: PolicyRule,
  found: readonly Finding[]
): string => {
  if (rule.status === "paused") {
    return "—";
  }
  const mine = found.filter((finding) => finding.rule.id === rule.id);
  const acting = mine.filter(({ state }) => state !== "excepted").length;
  const excepted = mine.length - acting;
  let main = t`No apps`;
  if (acting > 0 && rule.status === "watching") {
    main = plural(acting, {
      one: "Would catch # app",
      other: "Would catch # apps",
    });
  } else if (acting > 0 && rule.effect === "block") {
    main = plural(acting, { one: "# app blocked", other: "# apps blocked" });
  } else if (acting > 0) {
    main = plural(acting, { one: "# app flagged", other: "# apps flagged" });
  }
  return excepted > 0
    ? `${main} · ${plural(excepted, { one: "# exception", other: "# exceptions" })}`
    : main;
};

/* ── Labels ──────────────────────────────────────────────────────────── */

export const regionLabel: Record<HostingRegion, MessageDescriptor> = {
  eu: msg`the EU`,
  uk: msg`the United Kingdom`,
  us: msg`the United States`,
  china: msg`China`,
};

export const aiKindLabel: Record<AiKind, MessageDescriptor> = {
  tool: msg`AI tool`,
  builtIn: msg`AI built in`,
  none: msg`No AI`,
};

export const trainingLabel: Record<TrainingKind, MessageDescriptor> = {
  trains: msg`Trains on your data`,
  optOut: msg`Trains unless you opt out`,
  noTraining: msg`Does not train on your data`,
  unknown: msg`Training not stated`,
};

export const certificateLabel: Record<RequiredCertificate, MessageDescriptor> =
  {
    iso27001: msg`ISO 27001`,
    soc2: msg`SOC 2`,
    iso27701: msg`ISO 27701`,
    iso42001: msg`ISO 42001`,
  };

export const dpaLabel: Record<DpaState, MessageDescriptor> = {
  signed: msg({
    message: "Signed",
    context: "state of a data processing agreement",
  }),
  pending: msg({
    message: "Waiting for signature",
    context: "state of a data processing agreement",
  }),
  notFound: msg({
    message: "Missing",
    context: "state of a data processing agreement",
  }),
};

/** What a kind of access lets an app do with company data, as a verb. */
export const accessLabel: Record<DataAccessKind, MessageDescriptor> = {
  read: msg({
    message: "read",
    context: "what a permission lets an app do with company data",
  }),
  write: msg({
    message: "change",
    context: "what a permission lets an app do with company data",
  }),
  admin: msg({
    message: "administer",
    context: "what a permission lets an app do with company data",
  }),
};

export const extensionLabel: Record<ExtensionKind, MessageDescriptor> = {
  inUse: msg`Browser extension in use`,
  available: msg`Browser extension offered, not in use`,
};

export const effectLabel: Record<RuleEffect, MessageDescriptor> = {
  flag: msg({ message: "Flag", context: "what a policy rule does" }),
  block: msg({ message: "Block", context: "what a policy rule does" }),
};

export const effectDescription: Record<RuleEffect, MessageDescriptor> = {
  flag: msg`The app is marked in the landscape, so its owner can act on it.`,
  block: msg`The app is marked as blocked; access should be removed.`,
};

export const ruleStatusLabel: Record<RuleStatus, MessageDescriptor> = {
  watching: msg({ message: "Watching", context: "status of a policy rule" }),
  active: msg({ message: "Active", context: "status of a policy rule" }),
  paused: msg({ message: "Paused", context: "status of a policy rule" }),
};

export const ruleStatusDescription: Record<RuleStatus, MessageDescriptor> = {
  watching: msg`Shows which apps it would flag or block, without doing it.`,
  active: msg`Flags or blocks the apps that break it.`,
  paused: msg`Does nothing until it is turned on again.`,
};

export const findingStateLabel: Record<FindingState, MessageDescriptor> = {
  blocked: msg({
    message: "Blocked",
    context: "what a policy rule did to an app",
  }),
  flagged: msg({
    message: "Flagged",
    context: "what a policy rule did to an app",
  }),
  watching: msg({
    message: "Would apply",
    context: "what a watching policy rule would do to an app",
  }),
  excepted: msg({
    message: "Exception",
    context: "an app allowed to break a policy rule",
  }),
};

const names = <T extends string>(
  labels: Record<T, MessageDescriptor>,
  values: readonly T[]
): string[] => values.map((value) => i18n._(labels[value]));

const exposureName = (kind: DataExposureType): string =>
  i18n._(exposureMeta[kind].label).toLocaleLowerCase();

const certificateText = (
  condition: Extract<RuleCondition, { field: "certificate" }>
): string => {
  const [only] = condition.values;
  if (condition.values.length === 1 && only !== undefined) {
    const certificate = i18n._(certificateLabel[only]);
    return t`Vendor has no ${certificate}`;
  }
  const certificates = formatList(names(certificateLabel, condition.values));
  return condition.op === "lacksAll"
    ? t`Vendor has none of ${certificates}`
    : t`Vendor lacks one of ${certificates}`;
};

/** One condition as a short sentence: "Hosted outside the EU", "Touches customer data". */
export const conditionText = (condition: RuleCondition): string => {
  switch (condition.field) {
    case "hosting": {
      if (condition.op === "in") {
        const regions = formatOrList(names(regionLabel, condition.values));
        return t`Hosted in ${regions}`;
      }
      const regions = formatList(names(regionLabel, condition.values));
      return t`Hosted outside ${regions}`;
    }
    case "vendor": {
      const vendors = formatOrList(condition.values);
      return condition.op === "is"
        ? t`Made by ${vendors}`
        : t`Not made by ${vendors}`;
    }
    case "ai": {
      return formatOrList(names(aiKindLabel, condition.values));
    }
    case "training": {
      return formatOrList(names(trainingLabel, condition.values));
    }
    case "data": {
      const kinds = formatOrList(condition.values.map(exposureName));
      return t`Touches ${kinds}`;
    }
    case "people": {
      return plural(condition.moreThan, {
        one: "Used by more than # person",
        other: "Used by more than # people",
      });
    }
    case "owner": {
      return t`Has no owner`;
    }
    case "certificate": {
      return certificateText(condition);
    }
    case "dpa": {
      const states = formatOrList(
        names(dpaLabel, condition.values).map((state) =>
          state.toLocaleLowerCase()
        )
      );
      return t`Processing agreement ${states}`;
    }
    case "access": {
      const verbs = formatOrList(names(accessLabel, condition.values));
      return t`Can ${verbs} company data`;
    }
    case "extension": {
      return formatOrList(names(extensionLabel, condition.values));
    }
    default: {
      return condition satisfies never;
    }
  }
};
