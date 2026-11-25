import { describe, expect, it } from "vite-plus/test";

import { codeImportError, connectorCode } from "./imports.ts";

// Connector code imports what a connector is written with and its own
// files, nothing else: not Zod, not App code's SDK, not the runtime the
// SDK re-exports.

const files: ReadonlySet<string> = new Set(["src/index.ts", "src/items.ts"]);

/** Why `src/index.ts` may not import `specifier`, or undefined when it may. */
const errorFor = (specifier: string): string | undefined =>
  codeImportError(connectorCode, { specifier }, "src/index.ts", files);

describe("connector code's imports", () => {
  it.each(["@grasp-os/sdk/connector", "./items.ts"])(
    "allows %s",
    (specifier) => {
      expect(errorFor(specifier)).toBeUndefined();
    }
  );

  it.each(["zod", "@grasp-os/sdk/server", "@grasp-os/runtime/connector"])(
    "refuses %s",
    (specifier) => {
      expect(errorFor(specifier)).toBe(
        `"${specifier}" can't be imported here. Connector code can import its own files in src/ and @grasp-os/sdk/connector.`
      );
    }
  );
});
