import type { Workspace } from "@grasp-os/shared/brain";
import { describe, expect, it } from "vite-plus/test";

import {
  atlasOf,
  groupsOf,
  LOBES,
  REGION_IDS,
  signalPaths,
  storyOf,
  TEAM_FOLDER,
} from "./brain-atlas.ts";
import type { AtlasRegion, RegionId } from "./brain-atlas.ts";
import { buildBrain } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// The prototype's tests of the atlas, on the brain's test company: the
// board in front, the company's groups of teams in the lobes, what came
// in at the stem.

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

  it("puts the board in front, each of the company's groups of teams in a lobe with its work, and what came in at the stem", () => {
    expect({
      homes: Object.fromEntries(
        [
          "vision",
          "goal-answer",
          "src-vision",
          "sources-conversations",
          "team-service",
          "email-triage",
          "team-finance",
          "team-revenue",
        ].map((id) => [id, atlas.home.get(id)])
      ),
      names: LOBES.map((id) => region(id).name),
      does: region("parietal").does,
      // A team's work sits in the team's own folder.
      teamPath: region("parietal").notes.find(
        (note) => note.id === "team-service"
      )?.path,
      // Systems, applications and questions have no region of their own: they sit beside the work.
      unplaced: ["company", "app-chatgpt", "gap-budget"].filter((id) =>
        atlas.home.has(id)
      ),
    }).toStrictEqual({
      homes: {
        vision: "frontal",
        "goal-answer": "frontal",
        "src-vision": "stem",
        "sources-conversations": "stem",
        "team-service": "parietal",
        "email-triage": undefined,
        "team-finance": "occipital",
        // In no group the company keeps: one of its own, as Grasp would propose it.
        "team-revenue": "cerebellum",
      },
      names: ["Front office", "Back office", "Revenue", ""],
      does: "Customer service, Mortgage advice, and Client onboarding",
      teamPath: [TEAM_FOLDER, "team-service"],
      unplaced: [],
    });
    const work = region("parietal").notes.filter(
      (note) => note.kind === "candidate"
    );
    expect(work.length).toBeGreaterThan(0);
    expect(work.every((note) => note.path[0] === TEAM_FOLDER)).toBeTruthy();
  });

  it("proposes a group for every team the company placed in none, and holds the rest in the last lobe when there are more than four", () => {
    const none: Workspace = { ...ws, teamGroups: [] };
    const proposed = groupsOf(none);
    const partly: Workspace = {
      ...ws,
      teamGroups: [
        {
          id: "g",
          name: "Front office",
          teamIds: ["team-service", "team-gone"],
          confirmed: true,
        },
      ],
    };
    expect({
      lobes: proposed.length,
      confirmed: proposed.some((group) => group.confirmed),
      teams: proposed.flatMap((group) => group.teamIds).toSorted(),
      lastHoldsMore: (proposed.at(-1)?.teamIds.length ?? 0) > 1,
      partly: groupsOf(partly)[0],
    }).toStrictEqual({
      lobes: LOBES.length,
      confirmed: false,
      teams: ws.teams.map((team) => team.id).toSorted(),
      lastHoldsMore: true,
      partly: {
        id: "g",
        name: "Front office",
        teamIds: ["team-service"],
        confirmed: true,
      },
    });
  });

  it("shows only open questions someone can answer, beside every note each is about", () => {
    const open = new Set(atlas.open.map((item) => item.id));
    const complaints = atlas.open.find(
      (item) => item.id === "gap-complaints-volume"
    );
    expect({
      budget: open.has("gap-budget"),
      answered: open.has("gap-invoice-limit"),
      // The board's budget question is the gap already, so it is not asked twice.
      askedTwice: open.has("vision:budget"),
      // Beside the team it is about, and with the source it was noticed in.
      complaints: complaints?.regions,
      who: complaints?.who,
    }).toStrictEqual({
      budget: true,
      answered: false,
      askedTwice: false,
      complaints: ["occipital", "stem"],
      who: "Head of compliance",
    });
  });

  it("counts as waiting only what the note itself says is not there yet", () => {
    for (const each of atlas.regions) {
      expect(
        each.waiting.every(
          (id) =>
            brain.notes
              .find((note) => note.id === id)
              ?.tags.some((tag) =>
                ["not-interviewed", "never-mentioned", "reported"].includes(tag)
              ) === true
        )
      ).toBeTruthy();
    }
  });

  const between = (a: RegionId, b: RegionId) =>
    brain.edges.filter(
      ([from, to]) =>
        (atlas.home.get(from) === a && atlas.home.get(to) === b) ||
        (atlas.home.get(from) === b && atlas.home.get(to) === a)
    ).length;

  it("counts the links between regions from the brain's own edges", () => {
    expect(region("parietal").links.stem).toBe(between("parietal", "stem"));
    expect(region("parietal").links.occipital ?? 0).toBe(
      between("parietal", "occipital")
    );
    expect(region("parietal").links.parietal).toBeUndefined();
  });
});

describe(storyOf, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  const atlas = atlasOf(ws, brain);

  it("tells every region with teams in a few lines, each lighting up notes of the brain, ending with what is open", () => {
    const known = new Set(brain.notes.map((note) => note.id));
    for (const id of REGION_IDS.filter((each) => each !== "temporal")) {
      const lines = storyOf(id, atlas, ws);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const line of lines) {
        expect(line.text.length).toBeGreaterThan(0);
        expect(line.notes.length).toBeGreaterThan(0);
        expect(line.notes.every((note) => known.has(note))).toBeTruthy();
      }
    }
    const front = storyOf("parietal", atlas, ws).map((line) => line.text);
    expect(front[0]).toMatch(
      /^Customer service, Mortgage advice, and Client onboarding work here, on \d+ pieces? of work/u
    );
    expect(front.at(-1)).toMatch(/^Still open: /u);
  });

  it("runs each statement from the source that heard it, up the spine, to the teams and the work it is about", () => {
    const paths = signalPaths(ws, atlas);
    expect(paths.length).toBeGreaterThan(10);
    expect(
      paths.every((path) => path[0] === "stem" && path.length >= 2)
    ).toBeTruthy();
  });

  it("tells the same story every time", () => {
    expect(storyOf("parietal", atlas, ws)).toStrictEqual(
      storyOf("parietal", atlas, ws)
    );
  });
});
