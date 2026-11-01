import { describe, expect, it } from "vite-plus/test";

import {
  atlasCount,
  clusterFolder,
  exitRows,
  folderHolding,
  MAP_ROOM,
  mapDots,
  nameWidth,
  neuronMap,
  regionGroups,
  SOMA,
} from "./atlas-map.ts";
import type { MapRoom, NeuronMap } from "./atlas-map.ts";
import { atlasOf, REGION_IDS } from "./brain-atlas.ts";
import type { RegionId } from "./brain-atlas.ts";
import { buildBrain } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// The prototype's tests of the atlas's maps, on the brain's test company:
// the same assertions, with its counts where the company differs, and a
// long test split where the linter caps a test's assertions.

/** How many links a map sends out to the sources. */
const via = (map: NeuronMap) =>
  map.exits.find((exit) => exit.region === "stem")?.count ?? 0;

/** How many bands a map's groups hang in. */
const bandsOf = (map: NeuronMap) =>
  new Set(map.groups.map((group) => Math.round(group.y))).size;

const rooms: MapRoom[] = [
  { width: 1136, height: 836 },
  MAP_ROOM,
  { width: 544, height: 528 },
  { width: 1200, height: 300 },
  { width: 400, height: 760 },
];

/** Every region in every room. */
const everywhere: [MapRoom, RegionId][] = rooms.flatMap((room) =>
  REGION_IDS.map((id): [MapRoom, RegionId] => [room, id])
);

describe(neuronMap, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  const atlas = atlasOf(ws, brain);

  it("shows every note of a region, a folder note as the name of its group", () => {
    for (const id of REGION_IDS) {
      const map = neuronMap(id, atlas, brain, MAP_ROOM);
      const region = atlas.regions.find((each) => each.id === id);
      const shown = new Set([
        ...map.neurons.flatMap((neuron) => neuron.noteIds),
        ...map.groups.flatMap((group) => [group.noteId, group.parent?.noteId]),
      ]);
      expect(
        (region?.notes ?? [])
          .map((note) => note.id)
          .filter((note) => !shown.has(note))
      ).toStrictEqual([]);
      // Every neuron sits in a group, and every group has neurons.
      for (const group of map.groups.keys()) {
        expect(
          map.neurons.some((neuron) => neuron.group === group)
        ).toBeTruthy();
      }
    }
  });

  it("shows a crowded folder as one neuron, and each open question against the source it was noticed in", () => {
    // What came in holds too many notes to show at once: each folder is one neuron, to open.
    const stem = neuronMap("stem", atlas, brain, MAP_ROOM);
    expect(
      stem.neurons
        .filter((neuron) => neuron.kind !== "gap")
        .every((neuron) => neuron.kind === "cluster")
    ).toBeTruthy();
    // An open question sits with the source it was noticed in.
    expect(
      stem.neurons
        .filter((neuron) => neuron.kind === "gap")
        .every((neuron) => neuron.beside !== undefined)
    ).toBeTruthy();
    expect(
      stem.neurons.find(
        (neuron) =>
          clusterFolder(neuron.id) ===
          "Sources/Conversations/Employee interviews"
      )?.noteIds
    ).toHaveLength(22);
    // Folder by folder, in the vault's order; the documents' own note names their group, the conversations' note the folders under it.
    expect(stem.groups.map((group) => group.label)).toStrictEqual([
      "With the board",
      "Stakeholder interviews",
      "Employee interviews",
      "Chats with Grasp",
      "Pulse",
      "Documents",
      "Connections",
    ]);
    expect({
      documents: stem.groups.find((group) => group.label === "Documents")
        ?.noteId,
      above: stem.groups[0]?.parent?.label,
    }).toStrictEqual({
      documents: "sources-documents",
      above: "Conversations",
    });
  });

  it("puts each team's work under the team, the team naming its group", () => {
    const front = neuronMap("parietal", atlas, brain, MAP_ROOM);
    expect(
      front.groups.map((group) => [group.label, group.noteId, group.team])
    ).toStrictEqual([
      ["Customer service", "team-service", true],
      ["Mortgage advice", "team-mortgage", true],
      ["Client onboarding", "team-onboarding", true],
    ]);
    expect(
      regionGroups("occipital", atlas).map((group) => [
        group.label,
        group.count,
      ])
    ).toStrictEqual([
      ["Finance", 2],
      ["Compliance", 1],
    ]);
  });

  it("puts an open question against what it is about, with a synapse between them", () => {
    const back = neuronMap("occipital", atlas, brain, MAP_ROOM);
    const complaints = back.neurons.findIndex(
      (neuron) => neuron.id === "gap-complaints-volume"
    );
    const work = back.neurons.findIndex(
      (neuron) => neuron.id === "cand-complaints"
    );
    expect(back.neurons[complaints]?.state).toBe("open");
    expect(back.neurons[complaints]?.beside).toBe(work);
    expect(back.synapses).toContainEqual([
      Math.min(complaints, work),
      Math.max(complaints, work),
    ]);
  });

  it("draws only a handover both teams told as a nerve, and one only proposed dashed", () => {
    const front = neuronMap("parietal", atlas, brain, MAP_ROOM);
    const confirmed = atlas.nerves.filter((nerve) => nerve.link.confirmed);
    const proposed = atlas.nerves.filter((nerve) => !nerve.link.confirmed);
    expect({
      confirmed: confirmed.length > 0,
      proposed: proposed.length > 0,
      dashed: front.proposed?.length,
    }).toStrictEqual({ confirmed: true, proposed: true, dashed: 1 });
  });

  it("narrows a region to one of its folders, every note in it shown", () => {
    expect(
      regionGroups("stem", atlas).map((group) => group.count)
    ).toStrictEqual([2, 6, 22, 1, 1, 4, 3]);
    const employees = "Sources/Conversations/Employee interviews";
    for (const room of [MAP_ROOM, { width: 400, height: 760 }]) {
      const map = neuronMap("stem", atlas, brain, room, employees);
      expect({
        sources: map.neurons.filter((neuron) => neuron.kind === "source")
          .length,
        folded: map.neurons.some((neuron) => neuron.kind === "cluster"),
      }).toStrictEqual({ sources: 22, folded: false });
    }
    // Its ways out count only the links from what it shows.
    const narrowed = neuronMap("stem", atlas, brain, MAP_ROOM, employees);
    const whole = neuronMap("stem", atlas, brain, MAP_ROOM);
    expect(
      narrowed.exits.reduce((sum, exit) => sum + exit.count, 0)
    ).toBeLessThan(whole.exits.reduce((sum, exit) => sum + exit.count, 0));
  });

  it("opens a region to the folder a note is folded into, so the note is there to see", () => {
    expect(folderHolding("stem", atlas, brain, "src-vision")).toBe(
      "Sources/Conversations/With the board"
    );
    // A note shown as itself needs no folder opened.
    expect(
      folderHolding("occipital", atlas, brain, "cand-complaints")
    ).toBeUndefined();
  });

  it.each(everywhere)(
    "lays a region out the same way every time, every neuron with room for its name (%o, %s)",
    (room, id) => {
      const map = neuronMap(id, atlas, brain, room);
      expect(map.fits).toBeTruthy();
      // A name that needs a second line has it.
      expect(
        map.cell.lines + map.cell.short >= 2 ? map.cell.lines : 2
      ).toBeGreaterThanOrEqual(2);
      expect(
        neuronMap(id, atlas, brain, room).neurons.map((neuron) => [
          neuron.x,
          neuron.y,
        ])
      ).toStrictEqual(map.neurons.map((neuron) => [neuron.x, neuron.y]));
    }
  );

  it.each(everywhere)(
    "keeps every soma and name inside the room and clear of every other (%o, %s)",
    (room, id) => {
      const map = neuronMap(id, atlas, brain, room);
      const own = map.neurons.filter((neuron) => neuron.beside === undefined);
      const name = map.cell.lines * (map.cell.small ? 15 : 17.5) + 13;
      for (const [index, one] of own.entries()) {
        // A soma and the name under it, inside the room.
        expect(
          Math.abs(one.x) + nameWidth(map.cell.width) / 2
        ).toBeLessThanOrEqual(room.width / 2);
        expect(one.y + one.r).toBeLessThanOrEqual(room.height / 2 + 0.5);
        expect(one.y - one.r - name).toBeGreaterThanOrEqual(
          -room.height / 2 - 0.5
        );
        // And clear of every other: a cell apart across, or down.
        for (const other of own.slice(index + 1)) {
          expect(
            Math.abs(one.x - other.x) >= nameWidth(map.cell.width) + 2 ||
              Math.abs(one.y - other.y) >= one.r + name + other.r
          ).toBeTruthy();
        }
      }
      for (const [index, one] of map.neurons.entries()) {
        for (const other of map.neurons.slice(index + 1)) {
          expect(Math.hypot(one.x - other.x, one.y - other.y)).toBeGreaterThan(
            (one.r + other.r) * 0.9
          );
        }
      }
    }
  );

  it.each(everywhere)(
    "stands a group's name over its neurons, inside the room, in the width its group has (%o, %s)",
    (room, id) => {
      const map = neuronMap(id, atlas, brain, room);
      const own = map.neurons.filter((neuron) => neuron.beside === undefined);
      for (const [group, named] of map.groups.entries()) {
        const members = own.filter((neuron) => neuron.group === group);
        expect(named.y).toBeGreaterThan(
          Math.max(...members.map((neuron) => neuron.y + neuron.r))
        );
        expect(named.y).toBeLessThanOrEqual(room.height / 2);
        expect(named.width).toBeGreaterThan(map.cell.width * 0.8);
      }
    }
  );

  it("wraps groups under each other in a narrow room", () => {
    const wide = neuronMap("frontal", atlas, brain, {
      width: 1136,
      height: 836,
    });
    const flat = neuronMap("frontal", atlas, brain, {
      width: 1800,
      height: 260,
    });
    const narrow = neuronMap("frontal", atlas, brain, {
      width: 220,
      height: 760,
    });
    // The same notes: side by side in a flat room, group under group in a narrow one.
    expect(bandsOf(flat)).toBe(1);
    expect(bandsOf(narrow)).toBeGreaterThan(1);
    expect(narrow.neurons).toHaveLength(flat.neurons.length);
    // A neuron on a large screen is larger than on a small one, but never more than a soma gets.
    expect(wide.cell.soma).toBeGreaterThan(narrow.cell.soma);
    expect(
      neuronMap("parietal", atlas, brain, { width: 2400, height: 1300 }).cell
        .soma
    ).toBeLessThanOrEqual(58);
  });

  it("folds the fullest folders into one neuron each when there is no room to name every note", () => {
    const small = neuronMap("occipital", atlas, brain, {
      width: 200,
      height: 140,
    });
    const roomy = neuronMap("occipital", atlas, brain, {
      width: 1136,
      height: 836,
    });
    expect(small.fits).toBeTruthy();
    expect(small.neurons.length).toBeLessThan(roomy.neurons.length);
    expect(
      small.neurons.filter((neuron) => neuron.kind === "cluster").length
    ).toBeGreaterThan(
      roomy.neurons.filter((neuron) => neuron.kind === "cluster").length
    );
    // Nothing is left out: a folded folder still stands for every note in it.
    expect(
      new Set(small.neurons.flatMap((neuron) => neuron.noteIds))
    ).toStrictEqual(new Set(roomy.neurons.flatMap((neuron) => neuron.noteIds)));
  });

  it("sends links to other regions out over the room, in the atlas's order", () => {
    const front = neuronMap("parietal", atlas, brain, MAP_ROOM);
    // What came in runs to the stem, quietly: a way out to follow, never a nerve.
    expect(front.exits.find((exit) => exit.region === "stem")).toMatchObject({
      quiet: true,
    });
    expect(via(front)).toBeGreaterThan(0);
    expect(front.exits.map((exit) => exit.region)).toStrictEqual(
      REGION_IDS.filter((id) => front.exits.some((exit) => exit.region === id))
    );
    expect(front.exits.map((exit) => exit.x)).toStrictEqual(
      front.exits.map((exit) => exit.x).toSorted((a, b) => a - b)
    );
    for (const id of REGION_IDS) {
      const map = neuronMap(id, atlas, brain, MAP_ROOM);
      const highest = Math.max(
        ...map.neurons.map((neuron) => neuron.y + neuron.r),
        ...map.groups.map((group) => group.y)
      );
      for (const exit of map.exits) {
        expect(exit.y).toBeGreaterThan(highest);
      }
    }
  });

  it("puts the names of the ways out in rows that never run into each other", () => {
    const widths = [96, 152, 101, 126, 138];
    // Room for all: one row. Less: as few rows as hold them, in order, about as full as each other.
    expect({
      700: exitRows(widths, 700, 8),
      500: exitRows(widths, 500, 8),
      272: exitRows(widths, 272, 8),
    }).toStrictEqual({
      700: [[0, 1, 2, 3, 4]],
      500: [
        [0, 1, 2],
        [3, 4],
      ],
      272: [[0, 1], [2, 3], [4]],
    });
    for (const room of [700, 500, 272, 160, 90]) {
      const rows = exitRows(widths, room, 8);
      expect(rows.flat()).toStrictEqual([0, 1, 2, 3, 4]);
      // A row of several names fits; a name wider than the room stands alone.
      const widest = Math.max(
        ...rows
          .filter((row) => row.length > 1)
          .map(
            (row) =>
              row.reduce((sum, index) => sum + (widths[index] ?? 0), 0) +
              (row.length - 1) * 8
          ),
        0
      );
      expect(widest).toBeLessThanOrEqual(room);
    }
    expect(exitRows([], 300, 8)).toStrictEqual([]);
  });

  // Printing the whole figure takes a while on a busy machine.
  it(
    "draws a map in the figure's points, every neuron with a soma",
    { timeout: 30_000 },
    () => {
      const map = neuronMap("stem", atlas, brain, MAP_ROOM);
      const dots = mapDots(map, { x: 0, y: 0, reach: 1 / 600, zoom: 2.4 });
      expect(dots.x).toHaveLength(atlasCount());
      for (const index of map.neurons.keys()) {
        expect(
          dots.owner.some(
            (owner, at) =>
              owner === index &&
              dots.role[at] === SOMA &&
              dots.presence[at] === 1
          )
        ).toBeTruthy();
      }
    }
  );
});
