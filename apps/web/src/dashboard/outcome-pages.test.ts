import {
  unknownOutcomeListLimit,
  connectErrors,
} from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import type { Session } from "../core.ts";
import { everyPage, loadEveryPage } from "./outcome-pages.ts";

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

  it("loads each page on its own, and asks for none after one that fails", async () => {
    const pages = listOf(unknownOutcomeListLimit * 3);
    // SAFETY: the session is only handed on, never used here.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const session = {} as Session;
    const core = {
      withSession: async <T>(read: (session: Session) => Promise<T>) =>
        await read(session),
    };
    let reads = 0;
    const loaded = await loadEveryPage(core, async (_session, before) => {
      reads += 1;
      if (reads === 2) {
        throw connectErrors.create("connect.invalid");
      }
      return await pages.read(before);
    });
    const all = await loadEveryPage(
      core,
      async (_session, before) => await pages.read(before)
    );
    expect({
      loaded: loaded.state,
      reads,
      all: all.state === "ready" ? all.data.length : all.state,
    }).toStrictEqual({
      loaded: "refused",
      reads: 2,
      all: unknownOutcomeListLimit * 3,
    });
  });
});
