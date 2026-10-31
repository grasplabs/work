import { describe, expect, it } from "vite-plus/test";

import type {
  PolicyException,
  PolicyRule,
  RuleCondition,
} from "../src/policies.ts";
import {
  accessOfScopes,
  conditionMatches,
  conditionsMatch,
  findingsOf,
  unknownFacts,
} from "../src/policy-engine.ts";
import type { AppFacts, KnownApp } from "../src/policy-engine.ts";

// The policy engine (policy-engine.ts), as the prototype tests it
// (lib/policy.test.ts), over apps and rules made for the test: pure.

const facts = (patch: Partial<AppFacts>): AppFacts => ({
  ...unknownFacts,
  ...patch,
});

const chatGpt = facts({
  vendor: "OpenAI",
  ai: "tool",
  hosting: ["us"],
  data: ["customer", "credentials"],
  people: 47,
  hasOwner: true,
});
const kimi = facts({ vendor: "Moonshot", ai: "tool", hosting: ["china"] });
const unknown = unknownFacts;

const known = (name: string, appFacts: AppFacts, people: number | null) => ({
  app: {
    id: name.toLocaleLowerCase(),
    name,
    kind: "integration" as const,
    vendor: appFacts.vendor,
    people,
  },
  facts: appFacts,
});

const apps: KnownApp[] = [
  known("ChatGPT", chatGpt, 47),
  known("Kimi", { ...kimi, people: 6 }, 6),
  known("DeepSeek", facts({ ai: "tool", hosting: ["china"], people: 3 }), 3),
  known("Lender portals", unknown, null),
];

const rule = (
  conditions: RuleCondition[],
  patch: Partial<PolicyRule> = {}
): PolicyRule => ({
  id: "rule-test",
  revision: 1,
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

const today = "2026-09-28";

describe("conditions", () => {
  it("read hosting as inside or outside a set of regions, never matching hosting nothing states", () => {
    expect([
      conditionMatches({ field: "hosting", op: "in", values: ["china"] }, kimi),
      conditionMatches(
        { field: "hosting", op: "outside", values: ["eu"] },
        kimi
      ),
      conditionMatches(
        { field: "hosting", op: "outside", values: ["eu", "china"] },
        kimi
      ),
      conditionMatches(
        { field: "hosting", op: "outside", values: ["eu"] },
        unknown
      ),
    ]).toStrictEqual([true, true, false, false]);
  });

  it("compare vendors without minding case or spaces, and never match one nothing names", () => {
    expect([
      conditionMatches(
        { field: "vendor", op: "is", values: [" openai "] },
        chatGpt
      ),
      conditionMatches(
        { field: "vendor", op: "isNot", values: ["OpenAI"] },
        chatGpt
      ),
      conditionMatches(
        { field: "vendor", op: "isNot", values: ["OpenAI"] },
        unknown
      ),
    ]).toStrictEqual([true, false, false]);
  });

  it("match data and people, never counting more people than any number when nothing measures them", () => {
    expect([
      conditionMatches(
        { field: "data", values: ["health", "credentials"] },
        chatGpt
      ),
      conditionMatches({ field: "people", moreThan: 47 }, chatGpt),
      conditionMatches({ field: "people", moreThan: 46 }, chatGpt),
      conditionMatches({ field: "people", moreThan: 0 }, unknown),
    ]).toStrictEqual([true, false, true, false]);
  });

  it("catch an app nobody owns, never one whose owner nothing records", () => {
    expect([
      conditionMatches({ field: "owner" }, chatGpt),
      conditionMatches({ field: "owner" }, facts({ hasOwner: false })),
      conditionMatches({ field: "owner" }, unknown),
    ]).toStrictEqual([false, true, false]);
  });

  it("tell lacking any certificate from lacking all, counting an undeclared one as lacking", () => {
    const onlySoc2 = facts({ certificates: ["soc2"] });
    expect([
      conditionMatches(
        { field: "certificate", op: "lacksAny", values: ["iso27001"] },
        chatGpt
      ),
      // "ISO 27001 or SOC 2 is enough": SOC 2 alone keeps the app out.
      conditionMatches(
        { field: "certificate", op: "lacksAll", values: ["iso27001", "soc2"] },
        onlySoc2
      ),
      conditionMatches(
        { field: "certificate", op: "lacksAny", values: ["iso27001", "soc2"] },
        onlySoc2
      ),
    ]).toStrictEqual([true, false, true]);
  });

  it("read the processing agreement, access and extension, never matching what isn't known", () => {
    expect([
      conditionMatches(
        { field: "dpa", values: ["signed", "pending", "notFound"] },
        chatGpt
      ),
      conditionMatches(
        { field: "dpa", values: ["pending"] },
        facts({ dpa: "pending" })
      ),
      conditionMatches(
        { field: "access", values: ["write", "admin"] },
        facts({ access: ["read"] })
      ),
      conditionMatches(
        { field: "access", values: ["write", "admin"] },
        facts({ access: ["read", "write"] })
      ),
      conditionMatches(
        { field: "extension", values: ["inUse"] },
        facts({ extension: "available" })
      ),
      conditionMatches(
        { field: "extension", values: ["inUse", "available"] },
        unknown
      ),
    ]).toStrictEqual([false, true, false, true, false, false]);
  });

  it("know nothing of the AI of an app whose use of AI is unknown, and its training is not stated", () => {
    expect([
      conditionMatches(
        { field: "ai", values: ["tool", "builtIn", "none"] },
        unknown
      ),
      conditionMatches({ field: "training", values: ["unknown"] }, unknown),
    ]).toStrictEqual([false, true]);
  });

  it("all hold for a rule to match, and a rule without one catches nothing", () => {
    const deepSeek = facts({ ai: "tool", hosting: ["china"], people: 3 });
    expect([
      conditionsMatch(
        [{ field: "hosting", op: "in", values: ["china"] }],
        deepSeek
      ),
      conditionsMatch(
        [
          { field: "hosting", op: "in", values: ["china"] },
          { field: "people", moreThan: 10 },
        ],
        deepSeek
      ),
      conditionsMatch([], deepSeek),
    ]).toStrictEqual([true, false, false]);
  });
});

/** Each finding as its rule, its app's name and its state. */
const seen = (
  found: ReturnType<typeof findingsOf>
): [string, string, string][] =>
  found.map(({ ruleId, app, state }) => [ruleId, app.name, state]);

describe("findings", () => {
  const china = rule([{ field: "hosting", op: "in", values: ["china"] }], {
    id: "china",
    effect: "block",
  });
  const eu = rule([{ field: "hosting", op: "outside", values: ["eu"] }], {
    id: "eu",
  });
  const exception: PolicyException = {
    ruleId: "eu",
    appId: "chatgpt",
    reason: "Approved",
    until: "2026-09-28",
    grantedBy: "Test",
    grantedAt: "2026-09-01T10:00",
  };

  it("act only for active rules, show watching ones, skip paused ones, the most serious and most used first", () => {
    const found = findingsOf(
      [
        rule([{ field: "ai", values: ["tool"] }], {
          id: "watch",
          status: "watching",
        }),
        china,
        rule([{ field: "people", moreThan: 0 }], {
          id: "paused",
          status: "paused",
        }),
      ],
      apps,
      [],
      today
    );
    expect(seen(found)).toStrictEqual([
      ["china", "Kimi", "blocked"],
      ["china", "DeepSeek", "blocked"],
      ["watch", "ChatGPT", "watching"],
      ["watch", "Kimi", "watching"],
      ["watch", "DeepSeek", "watching"],
    ]);
  });

  it("let an exception hold until its last day, and name it", () => {
    const onTheDay = findingsOf([eu], apps, [exception], "2026-09-28");
    const dayAfter = findingsOf([eu], apps, [exception], "2026-09-29");
    expect({
      onTheDay: onTheDay.find(({ app }) => app.name === "ChatGPT"),
      dayAfter: dayAfter.find(({ app }) => app.name === "ChatGPT")?.state,
    }).toStrictEqual({
      onTheDay: {
        ruleId: "eu",
        app: apps[0]?.app,
        state: "excepted",
        exception,
      },
      dayAfter: "flagged",
    });
  });
});

describe("access from scopes", () => {
  it("reads, changes or administers company data, each including what reads it, and signing in is none of them", () => {
    expect({
      signIn: accessOfScopes(["openid", "profile", "email", "User.Read"]),
      read: accessOfScopes(["openid", "Mail.Read", "Calendars.Read"]),
      write: accessOfScopes(["Files.ReadWrite.All", "Mail.Send"]),
      admin: accessOfScopes(["Directory.ReadWrite.All"]),
      own: accessOfScopes(["User.ReadWrite"]),
      everyone: accessOfScopes(["User.ReadWrite.All"]),
    }).toStrictEqual({
      signIn: [],
      read: ["read"],
      write: ["read", "write"],
      admin: ["read", "write", "admin"],
      own: [],
      everyone: ["read", "write", "admin"],
    });
  });
});
