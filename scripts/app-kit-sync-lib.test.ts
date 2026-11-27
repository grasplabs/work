import { describe, expect, it } from "vite-plus/test";

import { problemsOf, sha256 } from "./app-kit-sync-lib.ts";
import type { LocalChange, RegistryPin } from "./app-kit-sync-lib.ts";

const registry = "export const Button = () => null\n";
const changed = "export const Button = () => 'changed'\n";

const pin: RegistryPin = {
  style: "base-nova",
  cli: "4.23.0",
  defaultStyleSource: "https://ui.shadcn.com/docs/cli",
  installed: "2026-11-27",
  files: {
    "src/components/button.tsx": sha256(registry),
    "src/components/card.tsx": sha256(registry),
  },
  own: ["src/hooks/use-settled.ts"],
};

const listed: LocalChange = {
  path: "src/components/button.tsx",
  reason: "Why",
  test: "packages/app-kit/test/components.test.tsx",
};

/** The problems of a kit holding `files`, by path. */
const problems = (
  files: Record<string, string>,
  changes: readonly LocalChange[] = []
): string[] =>
  problemsOf(
    pin,
    changes,
    (file) =>
      Object.hasOwn(files, file)
        ? new TextEncoder().encode(files[file])
        : undefined,
    Object.keys(files)
  );

describe("the App kit against the registry", () => {
  it("passes a kit that is what the registry installs, and its own files", () => {
    expect(
      problems({
        "src/components/button.tsx": registry,
        "src/components/card.tsx": registry,
        "src/hooks/use-settled.ts": "own",
      })
    ).toStrictEqual([]);
  });

  it("fails a change nobody listed, and passes it once listed", () => {
    const kit = {
      "src/components/button.tsx": changed,
      "src/components/card.tsx": registry,
    };
    expect(problems(kit)).toStrictEqual([
      expect.stringContaining(
        "src/components/button.tsx differs from what the registry installs"
      ),
    ]);
    expect(problems(kit, [listed])).toStrictEqual([]);
  });

  it("fails a listed change that is gone, a missing file and a stranger", () => {
    expect(
      problems(
        {
          "src/components/button.tsx": registry,
          "src/components/stat.tsx": "a Grasp part",
        },
        [listed]
      )
    ).toStrictEqual([
      expect.stringContaining(
        "src/components/stat.tsx is neither a file the registry installs"
      ),
      expect.stringContaining("src/components/button.tsx is listed"),
      "src/components/card.tsx is pinned but missing.",
    ]);
  });
});
