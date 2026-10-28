import type { PolicyApp, PolicyFinding } from "@grasp-os/shared/policies";
import { describe, expect, it } from "vite-plus/test";

import type { LandscapeApp } from "../landscape/landscape.ts";
import {
  applyPolicy,
  caughtText,
  conditionText,
  findingsWith,
  inForce,
  peopleAffected,
} from "./policy.ts";
import type { PolicyException, PolicyRule, RuleCondition } from "./policy.ts";

// The policies as the pages show them (policy.ts): core's findings joined
// to their rules, the landscape they mark, the people they affect, and
// rules and conditions in words. Which apps a rule catches is core's, and
// the engine's own tests (packages/shared/test/policy-engine.test.ts).

const landscapeApp = (
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
  users: null,
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

const policyApp = (name: string, people: number | null): PolicyApp => ({
  id: name.toLocaleLowerCase(),
  name,
  kind: "integration",
  vendor: null,
  people,
});

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

/** What core found, as it sends it. */
const core: PolicyFinding[] = [
  {
    ruleId: "china",
    app: policyApp("Kimi", 6),
    state: "blocked",
    exception: null,
  },
  {
    ruleId: "china",
    app: policyApp("DeepSeek", 3),
    state: "blocked",
    exception: null,
  },
  {
    ruleId: "eu",
    app: policyApp("Kimi", 6),
    state: "flagged",
    exception: null,
  },
  {
    ruleId: "eu",
    app: policyApp("DeepSeek", 3),
    state: "flagged",
    exception: null,
  },
  { ruleId: "eu", app: policyApp("ChatGPT", 47), state: "excepted", exception },
];

const book = { rules: [china, eu] };

describe("findings", () => {
  it("are joined to their rules, in core's order, leaving out one whose rule the book doesn't have", () => {
    const found = findingsWith({ rules: [china] }, core);
    expect(
      found.map(({ rule: { name }, app, state }) => [name, app.name, state])
    ).toStrictEqual([
      ["No tools hosted in China", "Kimi", "blocked"],
      ["No tools hosted in China", "DeepSeek", "blocked"],
    ]);
    expect(findingsWith(book, core).at(-1)?.exception).toStrictEqual(exception);
  });

  it("mark the landscape with the strongest rule, and only through rules", () => {
    const marked = applyPolicy(
      ["Kimi", "ChatGPT", "Lender portals"].map((name) =>
        landscapeApp({ name })
      ),
      findingsWith(book, core)
    );
    expect(
      marked.map(({ name, blocked, flagged, policySource }) => [
        name,
        blocked,
        flagged,
        policySource,
      ])
    ).toStrictEqual([
      ["Kimi", true, false, "No tools hosted in China"],
      // ChatGPT has an exception to the EU rule.
      ["ChatGPT", false, false, null],
      ["Lender portals", false, false, null],
    ]);
  });

  it("count the people using affected apps once per app, and know no total when nothing measures one", () => {
    const acting = inForce(findingsWith(book, core));
    const unmeasured = inForce(
      findingsWith(book, [
        ...core,
        {
          ruleId: "eu",
          app: policyApp("Lender portals", null),
          state: "flagged",
          exception: null,
        },
      ])
    );
    expect([peopleAffected(acting), peopleAffected(unmeasured)]).toStrictEqual([
      6 + 3,
      null,
    ]);
  });

  it("say how many apps a rule catches in the words of what it does", () => {
    const found = findingsWith(book, core);
    expect([
      caughtText(china, found),
      caughtText(eu, found),
      caughtText({ ...eu, status: "paused" }, found),
      caughtText({ ...eu, id: "none" }, found),
    ]).toStrictEqual([
      "2 apps blocked",
      "2 apps flagged · 1 exception",
      "—",
      "No apps",
    ]);
  });
});

describe("conditions", () => {
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
