/**
 * The hidden test set brought over from the prototype (import-hidden.ts):
 * each key written where `LAB_HIDDEN` says, as this lab reads it; one that
 * doesn't fit is refused by naming its fields, never what they hold. A
 * stand-in prototype checkout holds open keys in the hidden keys' place,
 * so no test reads a hidden key.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { importHidden } from "./import-hidden.ts";
import { HiddenSetError, keyOf, openKeys } from "./index.ts";

/** A checkout shaped like the prototype's, with `keys` as its hidden keys. */
const prototypeWith = (keys: Record<string, unknown>): string => {
  const checkout = mkdtempSync(path.join(tmpdir(), "lab-prototype-"));
  const folder = path.join(checkout, "packages/grasp/lab/keys/hidden");
  mkdirSync(folder, { recursive: true });
  for (const [name, key] of Object.entries(keys)) {
    writeFileSync(
      path.join(folder, name),
      `export const key = ${JSON.stringify(key)};\n`
    );
  }
  return checkout;
};

const hiddenHere = (): string => {
  const folder = mkdtempSync(path.join(tmpdir(), "lab-hidden-"));
  vi.stubEnv("LAB_HIDDEN", folder);
  return folder;
};

describe("the hidden test set, brought over from the prototype", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes each key where LAB_HIDDEN says, so the lab reads it, and says only how big it is", async () => {
    const folder = hiddenHere();
    const lines: string[] = [];
    const checkout = prototypeWith({
      "03-first.ts": { ...openKeys["01"], id: "03" },
      "06-second.ts": { ...openKeys["02"], id: "06" },
    });

    await importHidden(checkout, (line) => {
      lines.push(line);
    });

    expect(keyOf("03")?.facts).toStrictEqual(openKeys["01"]?.facts);
    expect(keyOf("06")?.employees).toStrictEqual(openKeys["02"]?.employees);
    expect(lines[0]).toBe(
      `Hidden key 03: ${openKeys["01"]?.facts.length} facts, ${openKeys["01"]?.employees.length} people, written to ${path.join(folder, "keys", "03.json")}.`
    );
  });

  it("refuses a key that doesn't fit, by its fields, without saying what they hold", async () => {
    hiddenHere();
    const checkout = prototypeWith({
      "03-first.ts": { ...openKeys["01"], id: "03", name: 42 },
      "06-second.ts": { ...openKeys["02"], id: "06" },
    });

    const refused = importHidden(checkout, () => {
      // Nothing to say before it is refused.
    });

    await expect(refused).rejects.toThrow(HiddenSetError);
    await expect(refused).rejects.toThrow("Hidden key 03 doesn't fit: name.");
  });

  it("refuses a checkout that isn't the prototype's", async () => {
    hiddenHere();

    await expect(
      importHidden(mkdtempSync(path.join(tmpdir(), "lab-elsewhere-")), () => {
        // Nothing is written.
      })
    ).rejects.toThrow(/There are no hidden keys/u);
  });
});
