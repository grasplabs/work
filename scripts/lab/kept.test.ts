/**
 * What the lab kept, read back (kept.ts): a file of an older shape, such
 * as a result whose `via` still names AI Gateway, is left out and said,
 * naming the file, never read another way nor quietly skipped.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { labViaSchema } from "@grasp-os/shared/lab";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { allKept } from "./kept.ts";

describe("what the lab kept, read back", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves out a file kept before what the lab keeps changed, and says which, to run again or delete", () => {
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
    const folder = mkdtempSync(path.join(tmpdir(), "lab-kept-"));
    const now = { quick: "anthropic/claude-haiku-4-5", careful: null };
    writeFileSync(path.join(folder, "a-now.json"), JSON.stringify(now));
    // Reached through AI Gateway, before it was removed.
    const before = path.join(folder, "b-before.json");
    writeFileSync(before, JSON.stringify({ gateway: "grasp-os", ...now }));
    const broken = path.join(folder, "c-broken.json");
    writeFileSync(broken, "{ not json");

    const kept = allKept(folder, labViaSchema);

    expect({ kept, warned }).toStrictEqual({
      kept: [now],
      warned: [before, broken].map(
        (file) =>
          `Left out ${file}: it doesn't fit what the lab keeps now, so it predates a change to it. Run it again, or delete it.`
      ),
    });
  });
});
