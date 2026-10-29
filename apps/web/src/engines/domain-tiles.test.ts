import { describe, expect, it } from "vite-plus/test";

import {
  fieldAt,
  heldStatuses,
  nameMatches,
  searchFrom,
} from "./domain-tiles.ts";

// How the Domains page lays out its tiles (domain-tiles.ts): the painted
// fields in turn, the status tabs only when two or more statuses hold a
// domain, and the search by name.

describe("the tiles' fields", () => {
  // Two fields side by side, or one above the other, in a grid of two
  // columns or of three, never share a painting or a pattern.
  it.each([2, 3])("differ from their neighbours in %i columns", (columns) => {
    const alike: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const field = fieldAt(index);
      const beside = index % columns === columns - 1 ? [] : [index + 1];
      for (const other of [...beside, index + columns]) {
        const neighbour = fieldAt(other);
        if (
          neighbour.painting === field.painting ||
          neighbour.pattern === field.pattern
        ) {
          alike.push(`${index} and ${other}`);
        }
      }
    }
    expect(alike).toStrictEqual([]);
  });

  it("come round again after the last", () => {
    const first = fieldAt(0);
    expect(
      new Set([0, 1, 2, 3, 4, 5].map((index) => fieldAt(index).painting))
    ).toHaveLength(6);
    expect(fieldAt(6)).toStrictEqual(first);
  });
});

describe("the status tabs", () => {
  it("are the statuses that hold a domain, in the prototype's order", () => {
    expect(
      heldStatuses(["archived", "draft", "draft", "published"])
    ).toStrictEqual(["published", "draft", "archived"]);
    expect(heldStatuses(["draft", "archived"])).toStrictEqual([
      "draft",
      "archived",
    ]);
  });

  it("are one or none when every domain has the same status, so no tabs show", () => {
    expect(heldStatuses(["published", "published"])).toStrictEqual([
      "published",
    ]);
    expect(heldStatuses([])).toStrictEqual([]);
  });
});

describe("the search", () => {
  it("is offered from seven domains", () => {
    expect(searchFrom).toBe(7);
  });

  it("finds any part of a name, in any case", () => {
    expect(nameMatches("Invoice handling", "VOICE")).toBeTruthy();
    expect(nameMatches("Invoice handling", " handling ")).toBeTruthy();
    expect(nameMatches("Invoice handling", "payroll")).toBeFalsy();
  });

  it("finds every name before anything is typed", () => {
    expect(nameMatches("Invoice handling", "")).toBeTruthy();
    expect(nameMatches("Invoice handling", "   ")).toBeTruthy();
  });
});
