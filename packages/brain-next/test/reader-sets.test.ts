// A set of readers' key read back as the access it names (reader-sets.ts):
// what a memory's readers, a person's own store and an export go by. Pure
// parsing, so tested on its own.
import { describe, expect, it } from "vite-plus/test";

import type { Access } from "../src/contract.ts";
import { accessOfKey, readerSetKeyOf } from "../src/reader-sets.ts";

describe("reading a set of readers' key", () => {
  it("names each access the Brain keys, as it was keyed", () => {
    const accesses: Access[] = [
      { kind: "none" },
      { kind: "owner", person: "person-1" },
      { kind: "audience", group: "team:sales" },
      { kind: "owner", person: 'a "quoted", [bracketed] person' },
      { kind: "readers", groups: ["account:a", "group:b", "tenant:c"] },
    ];

    expect(
      accesses.map((access) => accessOfKey(readerSetKeyOf(access)))
    ).toStrictEqual(accesses);
  });

  it("names readers of one group as that group's audience, and of several in any order as one set", () => {
    expect([
      accessOfKey(readerSetKeyOf({ kind: "readers", groups: ["team:sales"] })),
      readerSetKeyOf({ kind: "readers", groups: ["b", "a"] }) ===
        readerSetKeyOf({ kind: "readers", groups: ["a", "b"] }),
    ]).toStrictEqual([{ kind: "audience", group: "team:sales" }, true]);
  });

  it("names no one for a key the Brain doesn't write", () => {
    const keys = [
      "",
      "not json",
      "{}",
      '"person"',
      '[["person"]]',
      '[["person",5]]',
      '[["person","a","b"]]',
      '[["robot","a"]]',
      '[["person","a"],["group","b"]]',
      '[["group","a"],["person","b"]]',
      '[["group","b"],["group","a"]]',
      '[ ["person","a"] ]',
      '[["person","a"]] ',
    ];

    expect(keys.filter((key) => accessOfKey(key) !== undefined)).toStrictEqual(
      []
    );
  });
});
