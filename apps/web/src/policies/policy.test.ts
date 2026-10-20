import { describe, expect, it } from "vite-plus/test";

import type { LandscapeApp } from "../landscape/landscape.ts";
import {
  appFacts,
  applyPolicy,
  caughtText,
  conditionMatches,
  conditionText,
  findings,
  inForce,
  matchingApps,
  peopleAffected,
  ruleMatches,
} from "./policy.ts";
import type { PolicyException, PolicyRule, RuleCondition } from "./policy.ts";

// The policy engine, as the prototype tests it (lib/policy.test.ts), over
// apps and rules made for the test: Grasp keeps none of either yet.

const app = (
  patch: Partial<LandscapeApp> & { name: string }
): LandscapeApp => ({
  id: patch.name.toLocaleLowerCase(),
  vendor: null,
  category: null,
  description: null,
  aiType: "Unknown",
  dataExposure: null,
  dataExposureReason: "",
  hosting: [],
  users: 0,
  owner: null,
  firstSeen: "2026-09-01T10:00:00.000Z",
  connectionIds: [],
  use: { sources: ["native"], engines: [] },
  blocked: false,
  flagged: false,
  policySource: null,
  discovered: null,
  ...patch,
});

const apps = [
  app({
    name: "ChatGPT",
    vendor: "OpenAI",
    aiType: "Core",
    hosting: ["us"],
    dataExposure: ["customer", "credentials"],
    users: 47,
    owner: "Eva Bakker",
  }),
  app({
    name: "Kimi",
    vendor: "Moonshot",
    aiType: "Core",
    hosting: ["china"],
    users: 6,
  }),
  app({
    name: "DeepSeek",
    vendor: "DeepSeek",
    aiType: "Core",
    hosting: ["china"],
    users: 3,
  }),
  app({ name: "Lender portals" }),
];

const byName = (name: string): LandscapeApp => {
  const found = apps.find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`No app ${name}`);
  }
  return found;
};

const rule = (
  conditions: RuleCondition[],
  patch: Partial<PolicyRule> = {}
): PolicyRule => ({
  id: "rule-test",
  name: "Test rule",
  description: "",
  conditions,
  effect: "flag",
  status: "active",
  policyId: null,
  createdBy: "Test",
  createdAt: "2026-09-28T10:00",
  ...patch,
});

const names = (list: readonly { name: string }[]) =>
  list.map(({ name }) => name).toSorted();
const today = "2026-09-28";

describe("conditions", () => {
  it("reads hosting as inside or outside a set of regions", () => {
    const kimi = appFacts(byName("Kimi"));
    expect(
      conditionMatches({ field: "hosting", op: "in", values: ["china"] }, kimi)
    ).toBeTruthy();
    expect(
      conditionMatches(
        { field: "hosting", op: "outside", values: ["eu"] },
        kimi
      )
    ).toBeTruthy();
    expect(
      conditionMatches(
        { field: "hosting", op: "outside", values: ["eu", "china"] },
        kimi
      )
    ).toBeFalsy();
  });

  it("never matches hosting the vendor does not state", () => {
    const lenders = appFacts(byName("Lender portals"));
    expect(lenders.hosting).toStrictEqual([]);
    expect(
      conditionMatches({ field: "hosting", op: "in", values: ["us"] }, lenders)
    ).toBeFalsy();
    expect(
      conditionMatches(
        { field: "hosting", op: "outside", values: ["eu"] },
        lenders
      )
    ).toBeFalsy();
  });

  it("compares vendors without minding case or spaces, and never matches one nothing names", () => {
    const chatGpt = appFacts(byName("ChatGPT"));
    expect(
      conditionMatches(
        { field: "vendor", op: "is", values: [" openai "] },
        chatGpt
      )
    ).toBeTruthy();
    expect(
      conditionMatches(
        { field: "vendor", op: "isNot", values: ["OpenAI"] },
        chatGpt
      )
    ).toBeFalsy();
    const lenders = appFacts(byName("Lender portals"));
    expect(
      conditionMatches(
        { field: "vendor", op: "isNot", values: ["OpenAI"] },
        lenders
      )
    ).toBeFalsy();
  });

  it("matches data, people, owner and certificates", () => {
    const chatGpt = appFacts(byName("ChatGPT"));
    expect(
      conditionMatches(
        { field: "data", values: ["health", "credentials"] },
        chatGpt
      )
    ).toBeTruthy();
    expect(
      conditionMatches({ field: "people", moreThan: 47 }, chatGpt)
    ).toBeFalsy();
    expect(
      conditionMatches({ field: "people", moreThan: 46 }, chatGpt)
    ).toBeTruthy();
    expect(conditionMatches({ field: "owner" }, chatGpt)).toBeFalsy();
    expect(
      conditionMatches({ field: "owner" }, appFacts(byName("Lender portals")))
    ).toBeTruthy();
  });

  it("never counts more people than any number when nothing measures how many use an app", () => {
    expect(
      conditionMatches(
        { field: "people", moreThan: 0 },
        appFacts({ ...byName("ChatGPT"), users: null })
      )
    ).toBeFalsy();
  });

  it("tells lacking any certificate from lacking all, counting an undeclared one as lacking", () => {
    const chatGpt = appFacts(byName("ChatGPT"));
    expect(
      conditionMatches(
        { field: "certificate", op: "lacksAny", values: ["iso27001"] },
        chatGpt
      )
    ).toBeTruthy();
    const onlySoc2 = { ...chatGpt, certificates: ["soc2" as const] };
    // "ISO 27001 or SOC 2 is enough": SOC 2 alone keeps the app out; lacking every one catches it.
    expect(
      conditionMatches(
        { field: "certificate", op: "lacksAll", values: ["iso27001", "soc2"] },
        onlySoc2
      )
    ).toBeFalsy();
    expect(
      conditionMatches(
        { field: "certificate", op: "lacksAny", values: ["iso27001", "soc2"] },
        onlySoc2
      )
    ).toBeTruthy();
  });

  it("reads the processing agreement, access and extension, never matching what isn't known", () => {
    const chatGpt = appFacts(byName("ChatGPT"));
    expect([
      conditionMatches(
        { field: "dpa", values: ["signed", "pending", "notFound"] },
        chatGpt
      ),
      conditionMatches(
        { field: "dpa", values: ["pending"] },
        { ...chatGpt, dpa: "pending" }
      ),
    ]).toStrictEqual([false, true]);
    expect([
      conditionMatches(
        { field: "access", values: ["write", "admin"] },
        { ...chatGpt, access: ["read"] }
      ),
      conditionMatches(
        { field: "access", values: ["write", "admin"] },
        { ...chatGpt, access: ["read", "write"] }
      ),
    ]).toStrictEqual([false, true]);
    expect([
      conditionMatches(
        { field: "extension", values: ["inUse"] },
        { ...chatGpt, extension: "available" }
      ),
      conditionMatches(
        { field: "extension", values: ["inUse", "available"] },
        { ...chatGpt, extension: null }
      ),
    ]).toStrictEqual([false, false]);
  });

  it("knows nothing about the AI or training of an app whose use of AI is unknown", () => {
    const unknown = appFacts(byName("Lender portals"));
    expect(unknown.ai).toBeNull();
    expect(unknown.training).toBe("unknown");
    expect(
      conditionMatches(
        { field: "ai", values: ["tool", "builtIn", "none"] },
        unknown
      )
    ).toBeFalsy();
    expect(
      conditionMatches({ field: "training", values: ["unknown"] }, unknown)
    ).toBeTruthy();
  });

  it("needs every condition of a rule, and catches nothing without one", () => {
    const china = rule([{ field: "hosting", op: "in", values: ["china"] }]);
    expect(names(matchingApps(china, apps))).toStrictEqual([
      "DeepSeek",
      "Kimi",
    ]);
    expect(
      ruleMatches(
        rule([
          { field: "hosting", op: "in", values: ["china"] },
          { field: "people", moreThan: 10 },
        ]),
        byName("DeepSeek")
      )
    ).toBeFalsy();
    expect(matchingApps(rule([]), apps)).toStrictEqual([]);
  });

  it("says each condition plainly", () => {
    const conditions: RuleCondition[] = [
      { field: "hosting", op: "outside", values: ["eu"] },
      { field: "hosting", op: "in", values: ["us", "china"] },
      { field: "data", values: ["customer", "financial"] },
      { field: "people", moreThan: 1 },
      { field: "certificate", op: "lacksAll", values: ["iso27001", "soc2"] },
      { field: "certificate", op: "lacksAny", values: ["iso27001"] },
      { field: "dpa", values: ["pending", "notFound"] },
      { field: "access", values: ["write", "admin"] },
    ];
    expect(conditions.map(conditionText)).toStrictEqual([
      "Hosted outside the EU",
      "Hosted in the United States or China",
      "Touches customer data or financial data",
      "Used by more than 1 person",
      "Vendor has none of ISO 27001 and SOC 2",
      "Vendor has no ISO 27001",
      "Processing agreement waiting for signature or missing",
      "Can change or administer company data",
    ]);
  });
});

describe(findings, () => {
  const china = rule([{ field: "hosting", op: "in", values: ["china"] }], {
    id: "china",
    name: "No tools hosted in China",
    effect: "block",
  });
  const eu = rule([{ field: "hosting", op: "outside", values: ["eu"] }], {
    id: "eu",
    name: "Client data stays in the EU",
  });
  const exception: PolicyException = {
    ruleId: "eu",
    appId: "chatgpt",
    reason: "Approved",
    until: "2026-09-28",
    grantedBy: "Test",
    grantedAt: "2026-09-01T10:00",
  };

  it("acts only for active rules, shows watching ones, and skips paused ones", () => {
    const found = findings(
      [
        china,
        rule([{ field: "ai", values: ["tool"] }], {
          id: "watch",
          status: "watching",
        }),
        rule([{ field: "people", moreThan: 0 }], {
          id: "paused",
          status: "paused",
        }),
      ],
      apps,
      [],
      today
    );
    expect(
      new Set(
        found
          .filter((each) => each.rule.id === "china")
          .map(({ state }) => state)
      )
    ).toStrictEqual(new Set(["blocked"]));
    expect(
      new Set(
        found
          .filter((each) => each.rule.id === "watch")
          .map(({ state }) => state)
      )
    ).toStrictEqual(new Set(["watching"]));
    expect(found.some((each) => each.rule.id === "paused")).toBeFalsy();
    expect(found[0]?.state).toBe("blocked");
  });

  it("lets an exception hold until its last day", () => {
    const onTheDay = findings([eu], apps, [exception], "2026-09-28").find(
      (each) => each.app.name === "ChatGPT"
    );
    const dayAfter = findings([eu], apps, [exception], "2026-09-29").find(
      (each) => each.app.name === "ChatGPT"
    );
    expect(onTheDay?.state).toBe("excepted");
    expect(dayAfter?.state).toBe("flagged");
  });

  it("marks the landscape with the strongest rule, and only through rules", () => {
    const marked = applyPolicy(
      apps,
      findings([china, eu], apps, [exception], today)
    );
    expect(marked.find((each) => each.name === "Kimi")).toMatchObject({
      blocked: true,
      flagged: false,
      policySource: "No tools hosted in China",
    });
    // ChatGPT has an exception to the EU rule.
    expect(marked.find((each) => each.name === "ChatGPT")).toMatchObject({
      flagged: false,
      blocked: false,
      policySource: null,
    });
    expect(marked.find((each) => each.name === "Lender portals")).toMatchObject(
      { flagged: false, blocked: false }
    );
  });

  it("counts the people using affected apps once per app", () => {
    const found = inForce(findings([china, eu], apps, [], today));
    expect(peopleAffected(found)).toBe(47 + 6 + 3);
  });

  it("knows no total of people when nothing measures an affected app's usage", () => {
    const unmeasured = apps.map((each) =>
      each.name === "Kimi" ? { ...each, users: null } : each
    );
    const found = inForce(findings([china, eu], unmeasured, [], today));
    expect(peopleAffected(found)).toBeNull();
  });

  it("says how many apps a rule catches in the words of what it does", () => {
    const found = findings([china, eu], apps, [exception], today);
    expect(caughtText(china, found)).toBe("2 apps blocked");
    expect(caughtText(eu, found)).toBe("2 apps flagged · 1 exception");
    expect(caughtText({ ...eu, status: "paused" }, found)).toBe("—");
    expect(caughtText({ ...eu, id: "none" }, found)).toBe("No apps");
  });
});
