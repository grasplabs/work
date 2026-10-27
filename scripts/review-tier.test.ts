/**
 * How much review a pull request gets (review-tier.ts): its complexity
 * from its size and spread, and the Security floor from what it touches.
 */
import { describe, expect, it } from "vite-plus/test";

import { assess, parseFiles } from "./review-tier.ts";
import type { ChangedFile } from "./review-tier.ts";

const changed = (filename: string, lines: number): ChangedFile => ({
  filename,
  additions: lines,
  deletions: 0,
});

describe("ranking a pull request's complexity", () => {
  it("calls a small change in one place Low", () => {
    expect(
      assess([changed("apps/core/src/chat-messages.ts", 40)]).complexity
    ).toBe("Low");
  });

  it("calls a small change across two apps Medium", () => {
    expect(
      assess([
        changed("apps/core/src/chat-messages.ts", 20),
        changed("apps/web/src/chat/thread.tsx", 20),
      ]).complexity
    ).toBe("Medium");
  });

  it("calls a large change High", () => {
    expect(
      assess([changed("apps/core/src/workflows/engine.ts", 1001)]).complexity
    ).toBe("High");
  });

  it("calls a change across four apps or packages High, however small", () => {
    expect(
      assess(
        ["apps/core", "apps/web", "packages/sdk", "packages/ui"].map((area) =>
          changed(`${area}/src/name.ts`, 2)
        )
      ).complexity
    ).toBe("High");
  });

  it("weighs a test line a quarter of a code line", () => {
    const withTests = (testLines: number): string =>
      assess([
        changed("apps/core/src/chat-messages.ts", 40),
        changed("apps/core/test/chat-messages.test.ts", testLines),
      ]).complexity;

    expect(withTests(160)).toBe("Low");
    expect(withTests(164)).toBe("Medium");
  });

  it("leaves generated files out of the count", () => {
    expect(
      assess([
        changed("apps/core/src/chat-messages.ts", 10),
        changed("pnpm-lock.yaml", 5000),
        changed("apps/core/worker-configuration.d.ts", 3000),
        changed("apps/web/src/routeTree.gen.ts", 400),
        changed("apps/web/src/locales/de/messages.po", 300),
        changed(
          "apps/core/src/db/core/migrations/meta/0042_snapshot.json",
          9000
        ),
        changed("scripts/test-durations.json", 800),
      ]).complexity
    ).toBe("Low");
  });
});

describe("the Security floor", () => {
  it("marks sign-in, CI and the repository's rules as Security", () => {
    for (const filename of [
      "apps/core/src/auth/claims.ts",
      ".github/workflows/ci.yml",
      ".github/rulesets/main.json",
      ".github/CODEOWNERS",
    ]) {
      expect(assess([changed(filename, 1)]).security).toBeTruthy();
    }
  });

  it("marks server code named for what it guards as Security", () => {
    for (const filename of [
      "apps/core/src/permissions.ts",
      "apps/core/src/sandbox-session.ts",
      "apps/connect/src/tokens.ts",
      "apps/connect/src/oauth-client.ts",
      "apps/connect/src/egress.ts",
      "apps/connect/src/provider-rights.ts",
      "apps/core/src/knowledge/recall-grants.ts",
      "apps/core/src/audit-chain.ts",
      "apps/admin/src/deploy/sealed-secrets.ts",
      "packages/shared/src/permissions.ts",
    ]) {
      expect(assess([changed(filename, 1)]).security).toBeTruthy();
    }
  });

  it("leaves the theme's tokens, the frontend, tests and ordinary code alone", () => {
    for (const filename of [
      "packages/ui/src/styles/tokens.css",
      "apps/web/src/policies/policy-page.tsx",
      "apps/core/test/permission-probing.ts",
      "apps/core/test/permissions.test.ts",
      "apps/core/src/chat-messages.ts",
      "packages/shared/src/audit-log.ts",
      "pnpm-workspace.yaml",
    ]) {
      expect(assess([changed(filename, 1)]).security).toBeFalsy();
    }
  });

  it("says why, naming the files", () => {
    expect(
      assess([
        changed("apps/core/src/permissions.ts", 30),
        changed("apps/core/test/permissions.test.ts", 40),
      ]).reasons
    ).toStrictEqual([
      "30 code lines, 40 weighted with tests, in 1 area",
      "security: apps/core/src/permissions.ts",
    ]);
  });
});

describe("reading the changed files", () => {
  it("reads one file per line, as gh prints them across pages", () => {
    expect(
      parseFiles(
        '{"filename":"a.ts","additions":1,"deletions":2}\n\n{"filename":"b.ts","additions":3,"deletions":0}\n'
      )
    ).toStrictEqual([
      { filename: "a.ts", additions: 1, deletions: 2 },
      { filename: "b.ts", additions: 3, deletions: 0 },
    ]);
  });

  it("refuses a line that isn't a changed file", () => {
    expect(() => parseFiles('{"filename":"a.ts"}')).toThrow(
      "expected number, received undefined"
    );
  });
});
