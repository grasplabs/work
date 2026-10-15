import { describe, expect, it } from "vite-plus/test";

import { atlasOf, REGION_IDS, signalPaths, storyOf } from "./brain-atlas.ts";
import type { AtlasRegion, RegionId } from "./brain-atlas.ts";
import { buildBrain } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// The prototype's tests of the atlas, on the brain's test company: the
// same assertions, with its counts where the company differs.

describe(atlasOf, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  const atlas = atlasOf(ws, brain);
  const region = (id: RegionId): AtlasRegion => {
    const found = atlas.regions.find((each) => each.id === id);
    if (!found) {
      throw new Error(`No region ${id}`);
    }
    return found;
  };

  it("gives every note but the company one region, the part of the navigation its kind belongs to", () => {
    expect(atlas.home.has("company")).toBeFalsy();
    expect(
      brain.notes.filter((note) => {
        const home = atlas.home.get(note.id);
        return (
          note.id !== "company" &&
          (home === undefined || !REGION_IDS.includes(home))
        );
      })
    ).toStrictEqual([]);
    expect(
      Object.fromEntries(
        [
          "vision",
          "goal-answer",
          "app-chatgpt",
          "src-vision",
          "src-pulse",
          "src-directory",
          "sources-conversations",
          "gap-budget",
        ].map((id) => [id, atlas.home.get(id)])
      )
    ).toStrictEqual({
      vision: "vision",
      "goal-answer": "vision",
      "app-chatgpt": "tools",
      "src-vision": "sources",
      "src-pulse": "sources",
      "src-directory": "sources",
      "sources-conversations": "sources",
      "gap-budget": "gaps",
    });
    expect(REGION_IDS).toStrictEqual(
      expect.arrayContaining([
        "vision",
        "teams",
        "workflows",
        "tools",
        "gaps",
        "sources",
      ])
    );
    const counted = atlas.regions.reduce(
      (sum, each) => sum + each.notes.length,
      0
    );
    expect(counted).toBe(brain.notes.length - 1);
  });

  it("shows only open questions someone can answer, beside every note each is about", () => {
    const open = new Set(atlas.open.map((item) => item.id));
    // The board's budget question is the gap already, so it is not asked twice.
    expect({
      budget: open.has("gap-budget"),
      answered: open.has("gap-invoice-limit"),
      askedTwice: open.has("vision:budget"),
    }).toStrictEqual({ budget: true, answered: false, askedTwice: false });
    // A gap shows among the gaps, beside what it is about (a team and a workflow), and with the source it was noticed in.
    const complaints = atlas.open.find(
      (item) => item.id === "gap-complaints-volume"
    );
    expect(complaints?.regions).toStrictEqual([
      "gaps",
      "teams",
      "workflows",
      "sources",
    ]);
    expect(complaints?.who).toBe("Head of compliance");
    expect({
      vision: region("vision").open.length,
      teams: region("teams").open.length,
      tools: region("tools").open.length,
      workflows: region("workflows").open.length,
    }).toStrictEqual({ vision: 1, teams: 1, tools: 2, workflows: 1 });
    expect(region("gaps").open.map((item) => item.id)).toStrictEqual(
      atlas.open
        .filter((item) => item.id.startsWith("gap-"))
        .map((item) => item.id)
    );
  });

  it("counts as waiting only what the note itself says is not there yet", () => {
    expect(region("tools").waiting).toContain("app-chatgpt");
    expect(
      region("tools").waiting.every(
        (id) =>
          id.startsWith("app-") ||
          brain.notes
            .find((note) => note.id === id)
            ?.tags.includes("reported") === true
      )
    ).toBeTruthy();
    expect(region("teams").waiting).toStrictEqual([]);
    expect(region("tools").waitingLabel).toContain("14");
  });

  const between = (a: RegionId, b: RegionId) =>
    brain.edges.filter(
      ([from, to]) =>
        (atlas.home.get(from) === a && atlas.home.get(to) === b) ||
        (atlas.home.get(from) === b && atlas.home.get(to) === a)
    ).length;

  it("counts the links between regions from the brain’s own edges", () => {
    expect(region("teams").links.sources).toBe(between("teams", "sources"));
    expect(region("tools").links.workflows).toBe(between("tools", "workflows"));
    expect(region("teams").links.teams).toBeUndefined();
  });
});

describe(storyOf, () => {
  const ws = testWorkspace();
  const atlas = atlasOf(ws, buildBrain(ws));

  it("tells every region in a few lines, each lighting up notes of the brain", () => {
    for (const id of REGION_IDS) {
      const lines = storyOf(id, atlas, ws);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(line.text.length).toBeGreaterThan(0);
        expect(line.notes.length).toBeGreaterThan(0);
        for (const note of line.notes) {
          expect(atlas.home.has(note) || note === "vision").toBeTruthy();
        }
      }
    }
  });

  it("ends a region's story with what is open, after the facts found in the records", () => {
    const teams = storyOf("teams", atlas, ws).map((line) => line.text);
    expect(teams.at(-1)).toMatch(/^Still open: /u);
    expect(
      teams.some((text) => text.includes("both name the same handover"))
    ).toBeTruthy();
  });

  it("runs each statement from the source that heard it to what it is about", () => {
    const paths = signalPaths(ws, atlas);
    expect(paths.length).toBeGreaterThan(20);
    expect(
      paths.every(
        (path) =>
          (path[0] === "sources" || path[0] === "gaps") && path.length >= 2
      )
    ).toBeTruthy();
    expect(
      paths.some((path) => path.includes("teams") && path.includes("workflows"))
    ).toBeTruthy();
  });

  it("runs what is still unknown from the gaps to each region they are about", () => {
    // The gaps go to each region they are about.
    const wired = signalPaths(ws, atlas).filter((path) => path[0] === "gaps");
    const gapLinks =
      atlas.regions.find((region) => region.id === "gaps")?.links ?? {};
    expect(wired.length).toBeGreaterThan(0);
    expect(
      wired.every((path) => {
        const [, to] = path;
        return path.length === 2 && to !== undefined && (gapLinks[to] ?? 0) > 0;
      })
    ).toBeTruthy();
    expect(wired.map((path) => path[1])).toStrictEqual(
      expect.arrayContaining(["teams", "tools"])
    );
  });

  it("tells the same story every time", () => {
    expect(storyOf("tools", atlas, ws)).toStrictEqual(
      storyOf("tools", atlas, ws)
    );
  });
});
