import { describe, expect, it } from "vite-plus/test";

import {
  checkRecordOf,
  closureFingerprint,
  hasGlobalEffects,
  moduleRecordOf,
} from "./increments.ts";

// What a screens build may reuse of earlier ones (increments.ts): pure
// logic. Whole builds reusing them, against core's cache, are core's
// tests (apps/core/test/screen-increments.test.ts).

const files = {
  "screens/desk.tsx": "import { Card } from '../components/card';",
  "components/card.tsx": "import { Badge } from './badge';",
  "components/badge.tsx": "export const Badge = 1;",
  "components/other.tsx": "export const Other = 1;",
  "types.d.ts": "interface Probe {}",
};

const imports = new Map([
  ["screens/desk.tsx", new Set(["components/card.tsx"])],
  ["components/card.tsx", new Set(["components/badge.tsx"])],
]);

const fingerprint = async (
  changed: Record<string, string>,
  path = "screens/desk.tsx"
) =>
  await closureFingerprint(path, { ...files, ...changed }, imports, [
    "types.d.ts",
  ]);

describe("a file's check closure", () => {
  it("changes with any file its imports reach, through others, and with any declaration, never with another file", async () => {
    const same = await fingerprint({});
    expect({
      again: (await fingerprint({})) === same,
      reached: (await fingerprint({ "components/badge.tsx": "x" })) === same,
      declaration: (await fingerprint({ "types.d.ts": "x" })) === same,
      unreached: (await fingerprint({ "components/other.tsx": "x" })) === same,
    }).toStrictEqual({
      again: true,
      reached: false,
      declaration: false,
      unreached: true,
    });
  });
});

describe("global effects", () => {
  it("are a global declaration or a module augmentation outside a declaration file", () => {
    expect({
      global: hasGlobalEffects({ "a.ts": "declare global {}" }),
      module: hasGlobalEffects({ "a.ts": 'declare module "x" {}' }),
      declaration: hasGlobalEffects({ "a.d.ts": "declare global {}" }),
      none: hasGlobalEffects(files),
    }).toStrictEqual({
      global: true,
      module: true,
      declaration: false,
      none: false,
    });
  });
});

describe("records handed to a build", () => {
  it("are used only as their own file's, shaped as a record", () => {
    const module = {
      path: "components/card.tsx",
      code: "export {};",
      app: [],
      kit: [],
      candidates: [],
    };
    const check = {
      path: "components/card.tsx",
      closure: "c",
      found: [{ rule: "TS1", severity: "error", message: "m" }],
      references: [],
    };
    expect({
      module: moduleRecordOf(module, "components/card.tsx")?.path,
      otherFile: moduleRecordOf(module, "screens/desk.tsx"),
      badCode: moduleRecordOf({ ...module, code: 1 }, "components/card.tsx"),
      check: checkRecordOf(check, "components/card.tsx")?.closure,
      badSeverity: checkRecordOf(
        { ...check, found: [{ rule: "TS1", severity: "info", message: "m" }] },
        "components/card.tsx"
      ),
    }).toStrictEqual({
      module: "components/card.tsx",
      otherFile: undefined,
      badCode: undefined,
      check: "c",
      badSeverity: undefined,
    });
  });
});
