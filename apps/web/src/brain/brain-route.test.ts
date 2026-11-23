import { readdirSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { brainRoute } from "./brain-route.ts";

// An address in a page's text leads where the router takes it: every route
// the app has under the Brain, read from the routes folder, so a new one
// fails here until a page's link can reach it.

/** Each Brain route's path, from its file's name: `_shell.brain.sections.$sectionId.tsx` → `/brain/sections/$sectionId`. */
const brainRoutes = readdirSync(new URL("../routes", import.meta.url))
  .filter((file) => /^_shell\.brain\..+\.tsx$/u.test(file))
  .map((file) =>
    file
      .replace(/^_shell\./u, "/")
      .replace(/\.tsx$/u, "")
      .replace(/\.index$/u, "")
      .replaceAll(".", "/")
  );

/** A value with what an address must encode: a space, a slash, a hash, a question mark and a percent. */
const awkward = "a b/c#d?e%f";

/** The address of `path` with each parameter `awkward`, as a page's text writes it. */
const addressOf = (path: string): string =>
  path.replaceAll(/\$\w+/gu, encodeURIComponent(awkward));

/** The parameters `path` names, each `awkward`. */
const paramsOf = (path: string): Record<string, string> =>
  Object.fromEntries(
    [...path.matchAll(/\$(?<name>\w+)/gu)].map((match) => [
      match.groups?.name ?? "",
      awkward,
    ])
  );

describe("where an address in the Brain leads", () => {
  it("knows the Brain's routes", () => {
    expect(brainRoutes.toSorted()).toStrictEqual([
      "/brain",
      "/brain/$noteId",
      "/brain/activity",
      "/brain/memories",
      "/brain/opportunities",
      "/brain/sections/$sectionId",
      "/brain/skills",
      "/brain/sources",
    ]);
  });

  it.each(brainRoutes)("leads to %s, its parameters decoded", (path) => {
    const params = paramsOf(path);
    expect(brainRoute(addressOf(path))).toStrictEqual({
      hash: "",
      search: {},
      to: path,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    });
  });

  it("leads a part of the brain to its page, never to a note of that name", () => {
    expect(brainRoute("/brain/sections/vision")).toStrictEqual({
      hash: "",
      search: {},
      to: "/brain/sections/$sectionId",
      params: { sectionId: "vision" },
    });
  });

  it("leads a page's own address to the page, never to a note of the same id, as the router does", () => {
    expect(brainRoute("/brain/sources")?.to).toBe("/brain/sources");
  });

  it("keeps what comes after the path: the place on the page and the search", () => {
    expect(brainRoute("/brain/src-1#st%201")).toMatchObject({
      to: "/brain/$noteId",
      params: { noteId: "src-1" },
      hash: "st 1",
    });
    expect(brainRoute("/brain?region=frontal")).toStrictEqual({
      hash: "",
      search: { region: "frontal" },
      to: "/brain",
    });
    expect(brainRoute("/brain/")?.to).toBe("/brain");
  });

  it.each([
    "https://example.com/brain/vision",
    "//example.com/brain/vision",
    "/brainstorm",
    "/settings/brain",
    "/brain/a/b",
    "/brain/sections/a/b",
    "/brain//vision",
    "/brain/%E0%A4%A",
  ])("leads %s nowhere in the Brain", (href) => {
    expect(brainRoute(href)).toBeUndefined();
  });
});
