import { unknownOutcomeListLimit } from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import { everyPage } from "./outcome-pages.ts";

// Reading every page of a list of calls of unknown outcome (outcome-pages.ts):
// none past a full page goes unlisted, none is listed twice, and a list
// that ends on a full page doesn't go on for ever.

/** A list of `count` calls, newest first, served a page at a time. */
const listOf = (count: number) => {
  const all = Array.from({ length: count }, (_, index) => ({
    cursor: `${count - index}.${index}`,
  }));
  const asked: (string | undefined)[] = [];
  const read = async (before?: string) => {
    asked.push(before);
    const start =
      before === undefined
        ? 0
        : all.findIndex(({ cursor }) => cursor === before) + 1;
    return await Promise.resolve(
      all.slice(start, start + unknownOutcomeListLimit)
    );
  };
  return { all, asked, read };
};

describe("every page of calls of unknown outcome", () => {
  it("lists each once, past the first page, and stops after the last", async () => {
    const more = listOf(unknownOutcomeListLimit * 2 + 3);
    const exact = listOf(unknownOutcomeListLimit);
    const [moreListed, exactListed] = [
      await everyPage(more.read),
      await everyPage(exact.read),
    ];
    expect({
      more: moreListed.length,
      morePages: more.asked.length,
      exact: exactListed.length,
      exactPages: exact.asked,
    }).toStrictEqual({
      more: unknownOutcomeListLimit * 2 + 3,
      morePages: 3,
      exact: unknownOutcomeListLimit,
      exactPages: [undefined, exact.all.at(-1)?.cursor],
    });
  });
});
