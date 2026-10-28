import type {
  AiKind,
  DataAccessKind,
  DataExposureType,
  DpaState,
  ExtensionKind,
  FindingState,
  HostingRegion,
  PolicyApp,
  PolicyException,
  PolicyFinding,
  PolicyRule,
  RequiredCertificate,
  RuleCondition,
  TrainingKind,
} from "./policies.ts";

// The policy engine, as the prototype runs it (`lib/policy.ts`), which core
// runs over the apps it knows (core's policy-findings.ts). A rule matches
// an app when every one of its conditions does, and each condition reads
// one fact below. What a rule then does to the app follows from its
// status: a watching rule only shows what it would do, an active one flags
// or blocks, a paused one does nothing. An exception lets one app break
// one rule until a date. Pure: the facts are read by whoever runs it.

/** What Grasp knows about an app that a rule can check. Null is a fact Grasp does not know. */
export interface AppFacts {
  hosting: HostingRegion[];
  vendor: string | null;
  ai: AiKind | null;
  training: TrainingKind;
  data: DataExposureType[];
  /** How many use it; null while nothing measures it. */
  people: number | null;
  /** Whether someone owns it; null while nothing records owners. */
  hasOwner: boolean | null;
  certificates: RequiredCertificate[];
  dpa: DpaState | null;
  access: DataAccessKind[];
  extension: ExtensionKind | null;
}

/** The facts of an app Grasp knows nothing of yet: every one unknown. */
export const unknownFacts: AppFacts = {
  hosting: [],
  vendor: null,
  ai: null,
  training: "unknown",
  data: [],
  people: null,
  hasOwner: null,
  certificates: [],
  dpa: null,
  access: [],
  extension: null,
};

const sameVendor = (one: string, other: string) =>
  one.trim().toLocaleLowerCase() === other.trim().toLocaleLowerCase();

/** Whether more than `moreThan` use an app; never when nothing measures it. */
const usedByMoreThan = (people: number | null, moreThan: number): boolean =>
  people !== null && people > moreThan;

/**
 * Whether one condition holds for an app. What Grasp does not know never
 * matches: an app whose hosting the vendor does not state is neither inside
 * nor outside a region, one whose use of AI is unknown is no kind of AI,
 * and one whose owner nothing records is neither owned nor unowned. A
 * certificate the vendor does not declare is a fact in its own right: it
 * counts as one it lacks, as the condition says.
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
      return facts.hasOwner === false;
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

/** Whether every condition holds; a rule without conditions would catch every app, so it catches none. */
export const conditionsMatch = (
  conditions: readonly RuleCondition[],
  facts: AppFacts
): boolean =>
  conditions.length > 0 &&
  conditions.every((condition) => conditionMatches(condition, facts));

/** How serious each state is: the most serious first. */
export const findingStateRank: Record<FindingState, number> = {
  blocked: 0,
  flagged: 1,
  watching: 2,
  excepted: 3,
};

/** An exception counts up to and including its last day (`today`, an ISO date). */
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

/** An app, and what Grasp knows of it. */
export interface KnownApp {
  app: PolicyApp;
  facts: AppFacts;
}

/**
 * Every app each watching or active rule matches, the most serious first,
 * then the most used, then by name. `today` is an ISO date.
 */
export const findingsOf = (
  rules: readonly PolicyRule[],
  apps: readonly KnownApp[],
  exceptions: readonly PolicyException[],
  today: string
): PolicyFinding[] =>
  rules
    .filter((rule) => rule.status !== "paused")
    .flatMap((rule) =>
      apps
        .filter(({ facts }) => conditionsMatch(rule.conditions, facts))
        .map(({ app }) => {
          const exception = exceptionFor(exceptions, rule.id, app.id, today);
          return {
            ruleId: rule.id,
            app,
            state: stateOf(rule, exception),
            exception: exception ?? null,
          };
        })
    )
    .toSorted(
      (one, other) =>
        findingStateRank[one.state] - findingStateRank[other.state] ||
        (other.app.people ?? 0) - (one.app.people ?? 0) ||
        one.app.name.localeCompare(other.app.name)
    );

/**
 * Scopes that only sign a person in, or reach their own profile, which is
 * theirs to give (as `isHighPrivilegeScope` has it): no company data.
 */
const signInScopes = new Set([
  "openid",
  "profile",
  "email",
  "offline_access",
  "user.read",
  "user.readwrite",
]);

/** Scopes that administer the directory: who is who, and who may do what. */
const adminScope =
  /^(?:Directory|Group|GroupMember|Application|AppRoleAssignment|DelegatedPermissionGrant|RoleManagement|Policy)\.ReadWrite|^Directory\.AccessAsUser\.|^User\.ReadWrite\.All$/iu;

/** Scopes that change company data: write, send or manage it. */
const writeScope =
  /(?:ReadWrite|\.Write|\.Send|\.Manage|AccessAsUser|full_access)/iu;

/**
 * What an app's scopes at Microsoft let it do with company data, as a rule
 * checks it: read, change, administer, each also what the ones before it
 * do. Signing a person in, and their own profile, is none of them.
 */
export const accessOfScopes = (scopes: readonly string[]): DataAccessKind[] => {
  const kinds = new Set<DataAccessKind>();
  for (const scope of scopes) {
    if (signInScopes.has(scope.toLocaleLowerCase())) {
      continue;
    }
    kinds.add("read");
    if (adminScope.test(scope)) {
      kinds.add("write");
      kinds.add("admin");
    } else if (writeScope.test(scope)) {
      kinds.add("write");
    }
  }
  return (["read", "write", "admin"] as const).filter((kind) =>
    kinds.has(kind)
  );
};
