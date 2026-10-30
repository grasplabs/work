import type { ChatMessage } from "@grasp-os/shared/chat";
import type { ThinkingStep } from "@grasp-os/shared/thinking";
import { describe, expect, it } from "vite-plus/test";

import { atlasOf } from "../brain-atlas.ts";
import { buildBrain } from "../brain.ts";
import { testWorkspace } from "../test-workspace.ts";
import { BEAT, readFor, sayLength } from "./beats.ts";
import {
  DIVE,
  flightPose,
  project,
  REST,
  standing,
  viewProjection,
} from "./dive-scene.ts";
import { liveThinking, thinkingIn, thinkingSchedule } from "./play.ts";
import { markShared, samePainBeats } from "./same-pain.ts";
import {
  aboutRegion,
  figureAt,
  paceOf,
  thinkingMap,
  thinkingTeaches,
} from "./shapes.ts";

// Grasp's thinking in the brain, as pure numbers: the same-pain shape
// from a company's brain (its teams, what they said, in the brain's order,
// only what is in it), what the brain says beat by beat and how long each
// line stays up, where every neuron sits in rooms from a phone's to a large
// monitor's, when each step plays as the steps come, and the dive's camera.

const ws = testWorkspace();
const brain = buildBrain(ws);
const atlas = atlasOf(ws, brain);

const step = (
  move: ThinkingStep["move"],
  notes: string[],
  text = `Step ${move}`
): ThinkingStep => ({ text, notes, shape: "same-pain", move });

const trace: ThinkingStep[] = [
  step(
    "teams",
    ws.teams.map(({ id }) => id),
    "Reading what each team says slows it down"
  ),
  step("said", ["st-forward", "st-email-mortgage"]),
  step("together", [
    "team-service",
    "team-mortgage",
    "st-forward",
    "st-email-mortgage",
  ]),
];
const [teams, said, together] = trace.map((_, at) =>
  figureAt(trace, at, ws, brain, atlas)
);

/** Rooms from a phone's to a large monitor's. */
const ROOMS = [
  { width: 336, height: 484 },
  { width: 430, height: 620 },
  { width: 760, height: 560 },
  { width: 1100, height: 760 },
  { width: 1600, height: 900 },
];

describe("the same pain in more than one team", () => {
  it("looks only at what is in the brain", () => {
    const made = [step("said", ["team-finance", "made-up", "st-approvals"])];
    const shown = figureAt(made, 0, ws, brain, atlas);
    expect({
      teams: shown?.teams.map(({ id }) => id),
      words: shown?.words.map(({ id }) => id),
      nothing: figureAt([step("said", ["made-up"])], 0, ws, brain, atlas),
    }).toStrictEqual({
      teams: ["team-finance"],
      words: ["st-approvals"],
      nothing: undefined,
    });
  });

  it("reads every team, finds what was said, and pulls the teams that said it together with a nerve between them", () => {
    expect({
      read: teams?.teams.map(({ id }) => id),
      readWords: teams?.words,
      found: said?.words.map(({ id }) => id),
      involved: said?.teams.filter((team) => team.involved).map(({ id }) => id),
      financeStepsBack: said?.lit.includes("team-finance"),
      nerves: together?.nerves,
      teaches: thinkingTeaches(trace[2] ?? step("teams", []), ws),
    }).toStrictEqual({
      read: ws.teams.map(({ id }) => id),
      readWords: [],
      found: ["st-forward", "st-email-mortgage"],
      involved: ["team-service", "team-mortgage"],
      financeStepsBack: false,
      nerves: [["team-service", "team-mortgage"]],
      teaches: [["team-service", "team-mortgage"]],
    });
  });

  it("says each team's pain, then which team says the same as each thread runs, each line up as long as it takes to read", () => {
    if (teams === undefined || said === undefined || together === undefined) {
      throw new Error("The trace shows nothing");
    }
    const reading = samePainBeats(teams);
    const looking = samePainBeats(said);
    const map = thinkingMap(said, ROOMS[3] ?? { width: 1100, height: 760 });
    expect({
      lit: reading.map(({ lit }) => lit),
      kinds: looking.map(({ say }) => say.kind),
      last: looking.at(-1)?.say,
      threadsAsSaid: looking.map(({ at }) => at),
      found: samePainBeats(together),
      lead: teams.lead,
    }).toStrictEqual({
      lit: teams.teams.map(({ id }) => [id]),
      kinds: said.probes.map(({ holds }) => (holds ? "same" : "other")),
      last: { kind: "same", team: "Mortgage advice" },
      threadsAsSaid: map.probes.map(({ delay }) => delay),
      found: [],
      lead: readFor(trace[0]?.text.length ?? 0),
    });
    // Each beat after the step's own sentence, each line up as long as it takes to read.
    const paced = [
      { beats: reading, figure: teams },
      { beats: looking, figure: said },
    ].map(({ beats, figure }) => ({
      first: beats[0]?.at === (figure.lead ?? BEAT.lead),
      read: beats.every(
        (beat, at) =>
          at === 0 ||
          beat.at - (beats[at - 1]?.at ?? 0) ===
            readFor(sayLength(beats[at - 1]?.say ?? beat.say))
      ),
    }));
    expect(paced).toStrictEqual([
      { first: true, read: true },
      { first: true, read: true },
    ]);
    // Looking takes longest, while threads are tried and let go.
    expect(paceOf(trace[1] ?? step("said", []), [])).toBeGreaterThan(
      paceOf(trace[0] ?? step("teams", []), [])
    );
  });

  it("says who said what found as a role and a team, never a name, and underlines the words both teams used", () => {
    expect({
      by: together?.words.map(
        ({ by }) =>
          by.endsWith(" · Customer service") ||
          by.endsWith(" · Mortgage advice")
      ),
      shared: together?.shared,
      marked: markShared(
        "Forwarded questions from customer service pile up in our mailbox",
        together?.shared ?? []
      ),
    }).toStrictEqual({
      by: [true, true],
      shared: ["question", "forward"],
      marked: [
        { text: "Forwarded", shared: true },
        { text: " ", shared: false },
        { text: "questions", shared: true },
        {
          text: " from customer service pile up in our mailbox",
          shared: false,
        },
      ],
    });
  });

  it("keeps every neuron and the line inside the room, from a phone's to a large monitor's", () => {
    const outside = ROOMS.flatMap((room) =>
      [teams, said, together].flatMap((figure) => {
        if (figure === undefined) {
          return [];
        }
        const map = thinkingMap(figure, room);
        return [
          ...map.neurons.filter(
            (neuron) =>
              Math.abs(neuron.x) + neuron.r > room.width / 2 ||
              Math.abs(neuron.y) + neuron.r > room.height / 2
          ),
          ...(map.caption.width > room.width ? [map.caption] : []),
        ];
      })
    );
    expect(outside).toStrictEqual([]);
  });

  it("leads back from the picture to the part of the brain that holds the teams it found", () => {
    expect(aboutRegion(trace, atlas)).toBe(atlas.home.get("team-service"));
  });
});

const at = "2026-10-29T09:00:00.000Z";
describe("playing Grasp's thinking as it comes", () => {
  it("shows each step when it arrives, but never before the one before had its own time", () => {
    expect([
      thinkingSchedule(1000, [2600, 4600, 2600]),
      thinkingSchedule(1000, [2600, 4600, 2600], [1000, 1200, 20_000]),
    ]).toStrictEqual([
      [1000, 3600, 8200],
      [1000, 3600, 20_000],
    ]);
  });

  it("plays the newest question's steps once they reached this tab, until the picture is put away", () => {
    const shown = step("teams", ["team-service"]);
    const messages: ChatMessage[] = [
      { id: 1, role: "user", text: "Same pain anywhere?", at },
      {
        id: 2,
        role: "assistant",
        text: "",
        citations: [],
        code: [],
        end: "done",
        at,
      },
      {
        id: 3,
        role: "result",
        callId: "c1",
        text: "Shown in the brain.",
        failed: false,
        thinking: shown,
        at,
      },
      {
        id: 4,
        role: "result",
        callId: "c2",
        text: "Not in the brain",
        failed: true,
        at,
      },
      {
        id: 5,
        role: "assistant",
        text: "Both forward.",
        citations: [],
        code: [],
        end: "done",
        at,
      },
    ];
    const arrived = new Map([["c1", 5000]]);
    expect({
      kept: thinkingIn(messages),
      live: liveThinking(messages, arrived, new Set(), true),
      notArrived: liveThinking(messages, new Map(), new Set(), true),
      putAway: liveThinking(messages, arrived, new Set([1]), true),
      askedAgain: liveThinking(
        [...messages, { id: 6, role: "user", text: "And?", at }],
        arrived,
        new Set(),
        true
      ),
    }).toStrictEqual({
      kept: [{ questionId: 1, steps: [shown], calls: ["c1"] }],
      live: {
        questionId: 1,
        steps: [shown],
        calls: ["c1"],
        arrivals: [5000],
        open: true,
      },
      notArrived: undefined,
      putAway: undefined,
      askedAgain: undefined,
    });
  });
});

/** A laptop's canvas and a phone's. */
const SCREENS = [
  { width: 1280, height: 760 },
  { width: 375, height: 640 },
];

describe("the dive's camera", () => {
  it("stands each neuron where the shape's layout puts it on the screen", () => {
    for (const screen of SCREENS) {
      const matrix = viewProjection(REST, screen);
      for (const [x, y] of [
        [screen.width / 2, screen.height / 2],
        [40, 60],
        [screen.width - 30, screen.height - 90],
      ] as const) {
        const seen = project(standing(x, y, screen).at, matrix, screen);
        expect(seen.x).toBeCloseTo(x, 3);
        expect(seen.y).toBeCloseTo(y, 3);
        expect(seen.depth).toBeCloseTo(DIVE.depth, 5);
      }
    }
  });

  it("flies from outside, the brain whole on any screen, to rest inside it", () => {
    for (const screen of SCREENS) {
      const aspect = screen.width / screen.height;
      const start = flightPose(0, aspect);
      const matrix = viewProjection(start, screen);
      for (const side of [
        [-0.96, 0, 0],
        [0.96, 0, 0],
        [0, 0.67, 0],
      ] as const) {
        const seen = project([side[0], side[1], side[2]], matrix, screen);
        expect(seen.x).toBeGreaterThan(0);
        expect(seen.x).toBeLessThan(screen.width);
        expect(seen.y).toBeGreaterThan(0);
      }
      const end = flightPose(1, aspect);
      expect({
        start: start.inside,
        eye: end.eye.map((value) => Number(value.toFixed(6))),
        fov: end.fov,
        inside: end.inside,
      }).toStrictEqual({
        start: 0,
        eye: REST.eye,
        fov: DIVE.fov.inside,
        inside: 1,
      });
    }
  });
});
