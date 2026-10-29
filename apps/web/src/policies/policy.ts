import type {
  AiKind,
  DataAccessKind,
  DpaState,
  ExtensionKind,
  FindingState,
  PolicyApp,
  PolicyBook,
  PolicyException,
  PolicyFinding,
  PolicyRule,
  RequiredCertificate,
  RuleCondition,
  RuleEffect,
  RuleStatus,
  TrainingKind,
} from "@grasp-os/shared/policies";
import { findingStateRank } from "@grasp-os/shared/policy-engine";
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

// The company's policies as the pages show them, as the prototype does
// (`lib/policy.ts`). Core keeps the rules, policies and exceptions, and
// works out which apps each rule catches from what it knows of them
// (`session.policies.findings()`, through @grasp-os/shared/policy-engine);
// here they are joined to their rules, counted and put in words.

export type {
  AiKind,
  FindingState,
  PolicyApp,
  PolicyBook,
  DataAccessKind,
  DpaState,
  ExtensionKind,
  PolicyDocument,
  PolicyException,
  PolicyFinding,
  PolicyReadingProblem,
  PolicyRule,
  ProposalCatch,
  RequiredCertificate,
  RuleCondition,
  RuleEffect,
  RuleField,
  RuleProposal,
  RuleStatus,
  TrainingKind,
  UncheckedRequirement,
} from "@grasp-os/shared/policies";

/* ── Findings ────────────────────────────────────────────────────────── */

/** One app one rule catches, with the rule: what core found, as the pages show it. */
export interface Finding {
  rule: PolicyRule;
  app: PolicyApp;
  state: FindingState;
  /** The exception that lets the app be, when there is one. */
  exception?: PolicyException;
}

/**
 * Core's findings with their rules from `book`, in core's order. One whose
 * rule the book doesn't have (read a moment apart) is left out.
 */
export const findingsWith = (
  book: Pick<PolicyBook, "rules">,
  found: readonly PolicyFinding[]
): Finding[] => {
  const rules = new Map(book.rules.map((rule) => [rule.id, rule]));
  return found.flatMap(({ ruleId, app, state, exception }) => {
    const rule = rules.get(ruleId);
    if (rule === undefined) {
      return [];
    }
    return exception === null
      ? [{ rule, app, state }]
      : [{ rule, app, state, exception }];
  });
};

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
      findingStateRank[finding.state] < findingStateRank[current.state]
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
  const apps = new Map(found.map(({ app }) => [app.id, app.people]));
  let sum = 0;
  for (const people of apps.values()) {
    if (people === null) {
      return null;
    }
    sum += people;
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
