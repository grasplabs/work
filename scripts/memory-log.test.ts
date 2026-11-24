import { describe, expect, it } from "vite-plus/test";

import { memorySample, parseRss } from "./memory-log.ts";

const gib = 1024 ** 3;
const at = new Date("2026-11-05T02:41:07.000Z");

describe("a memory sample", () => {
  it("names the programs that hold the most, with how many of each run, from ps", () => {
    const rows = parseRss(
      [
        "  2097152 /usr/local/bin/workerd",
        "  1048576 workerd",
        "   524288 node",
        "     1024 bash",
        "      512 ps",
        "   262144 chrome",
        "    65536 sh",
        "not a row",
      ].join("\n")
    );

    expect(
      memorySample({
        at,
        availableBytes: 9.75 * gib,
        totalBytes: 16 * gib,
        rows,
      })
    ).toBe(
      "[memory 02:41:07] 9.8 GiB available of 16.0 GiB; most held by workerd 3.0 GiB (2), node 0.5 GiB (1), chrome 0.3 GiB (1), sh 0.1 GiB (1)\n"
    );
  });

  it("warns that a runner that stops after it likely ran out of memory, once little is available", () => {
    const sample = memorySample({
      at,
      availableBytes: 1.2 * gib,
      totalBytes: 16 * gib,
      rows: [{ program: "workerd", rssKib: 13 * 1024 * 1024 }],
    });

    expect(sample.split("\n")).toStrictEqual([
      "[memory 02:41:07] 1.2 GiB available of 16.0 GiB; most held by workerd 13.0 GiB (1)",
      "::warning title=memory::Only 1.2 GiB of 16.0 GiB is available: if the runner stops after this (a shutdown signal), it likely ran out of memory.",
      "",
    ]);
  });

  it("still says what is available when ps listed nothing", () => {
    expect(
      memorySample({
        at,
        availableBytes: 8 * gib,
        totalBytes: 16 * gib,
        rows: [],
      })
    ).toBe(
      "[memory 02:41:07] 8.0 GiB available of 16.0 GiB; most held by nothing listed\n"
    );
  });
});
