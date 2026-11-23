/**
 * What packages/ui must hold for its pin (ui-sync-lib.ts): the added items
 * with what they build on, and each way the package can leave Damsko's.
 */
import { describe, expect, it } from "vite-plus/test";

import { differences, expectedOf, parseRegistry } from "./ui-sync-lib.ts";

const registry = parseRegistry(
  JSON.stringify({
    items: [
      {
        name: "lib",
        dependencies: ["@stylexjs/stylex"],
        files: [{ path: "src/lib/utils.ts", target: "~/src/lib/utils.ts" }],
      },
      {
        name: "spinner",
        registryDependencies: ["@damsko/lib"],
        files: [
          {
            path: "src/components/spinner.tsx",
            target: "~/src/components/spinner.tsx",
          },
        ],
      },
      {
        name: "button",
        dependencies: ["@ui-sdk/react"],
        registryDependencies: ["@damsko/lib", "@damsko/spinner"],
        files: [
          {
            path: "src/components/button.tsx",
            target: "~/src/components/button.tsx",
          },
        ],
      },
      {
        name: "fonts",
        files: [
          {
            path: "src/styles/fonts/geist.woff2",
            target: "~/src/styles/fonts/geist.woff2.base64",
          },
        ],
      },
      {
        name: "dialog",
        files: [
          {
            path: "src/components/dialog.tsx",
            target: "~/src/components/dialog.tsx",
          },
        ],
      },
    ],
  })
);

const bytes = (text: string) => new TextEncoder().encode(text);

/** Damsko's files: each holds its own path. */
const damsko = (path: string) => bytes(path);

const inStep = {
  "src/lib/utils.ts": "src/lib/utils.ts",
  "src/components/spinner.tsx": "src/components/spinner.tsx",
  "src/components/button.tsx": "src/components/button.tsx",
};

const named = { "@stylexjs/stylex": "catalog:", "@ui-sdk/react": "catalog:" };

const installed = (
  files: Record<string, string>,
  dependencies: Record<string, string> = named
) => ({
  read: (path: string) =>
    Object.hasOwn(files, path) ? bytes(files[path] ?? "") : undefined,
  sources: Object.keys(files),
  dependencies,
});

describe("what packages/ui must hold", () => {
  it("is each added item and every item it builds on", () => {
    const expected = expectedOf(registry, ["button"]);
    expect([...expected.files.keys()].toSorted()).toStrictEqual([
      "src/components/button.tsx",
      "src/components/spinner.tsx",
      "src/lib/utils.ts",
    ]);
    expect([...expected.dependencies].toSorted()).toStrictEqual([
      "@stylexjs/stylex",
      "@ui-sdk/react",
    ]);
  });

  it("holds a font as the font, not as the text it travels as", () => {
    const expected = expectedOf(registry, ["fonts"]);
    const font = "src/styles/fonts/geist.woff2";
    expect([...expected.files.keys()]).toStrictEqual([font]);
    expect(
      differences(expected, damsko, installed({ [font]: font }, {}))
    ).toStrictEqual([]);
    expect(
      differences(
        expected,
        damsko,
        installed({ [`${font}.base64`]: "packed" }, {})
      ).toSorted()
    ).toStrictEqual([
      `${font} is missing`,
      `${font}.base64 is no file of the installed items`,
    ]);
  });

  it("refuses an item the registry does not have", () => {
    expect(() => expectedOf(registry, ["tag"])).toThrow(/no item "tag"/u);
  });

  it("finds nothing when every file is Damsko's", () => {
    expect(
      differences(expectedOf(registry, ["button"]), damsko, installed(inStep))
    ).toStrictEqual([]);
  });

  it("names a file edited in place, one missing and one that is not Damsko's", () => {
    const { "src/components/spinner.tsx": _, ...rest } = inStep;
    expect(
      differences(
        expectedOf(registry, ["button"]),
        damsko,
        installed({
          ...rest,
          "src/components/button.tsx": "edited",
          "src/components/dialog.tsx": "src/components/dialog.tsx",
        })
      ).toSorted()
    ).toStrictEqual([
      "src/components/button.tsx differs from Damsko's src/components/button.tsx",
      "src/components/dialog.tsx is no file of the installed items",
      "src/components/spinner.tsx is missing",
    ]);
  });

  it("names a package the CLI wrote a version for", () => {
    expect(
      differences(
        expectedOf(registry, ["lib"]),
        damsko,
        installed(
          { "src/lib/utils.ts": "src/lib/utils.ts" },
          { "@stylexjs/stylex": "^0.19.2" }
        )
      )
    ).toStrictEqual([
      'package.json: @stylexjs/stylex must be a dependency at "catalog:", and is "^0.19.2"',
    ]);
  });
});
