import { describe, expect, it } from "vite-plus/test";

import {
  extractionMarkers,
  readExtractionRun,
  scoreExtraction,
} from "../apps/core/test/fixtures/brain-extraction-eval/scoring.ts";
import type {
  DrawResult,
  ProbeResult,
  ReadMemory,
} from "../apps/core/test/fixtures/brain-extraction-eval/scoring.ts";
import type {
  EvalFact,
  ExtractionEvalSet,
} from "../apps/core/test/fixtures/brain-extraction-eval/set.ts";

// Scoring the evaluation of extraction (GRA-1992) from what a run read,
// with a model of the test's own: each case is what a reader would have
// read after a draw or a probe, written out here.

const acme = { kind: "customer", name: "Acme Corp" } as const;
const renewal: EvalFact = {
  about: acme,
  attribute: "renewal_date",
  value: "2027-03-01",
  quote: "Acme Corp renews on 1 March 2027",
};
const location: EvalFact = {
  about: acme,
  attribute: "location",
  value: ["Leeds", "Leeds, UK"],
  quote: "Acme Corp is based in Leeds",
};
const owner: EvalFact = {
  about: acme,
  attribute: "account_owner",
  object: { kind: "person", name: "Jo Bell" },
  quote: "Its account owner is Jo Bell",
};
const laterRenewal: EvalFact = {
  ...renewal,
  value: "2027-09-01",
  quote: "Acme Corp now renews on 1 September 2027",
};
const plantStatement = "Acme Corp has cancelled.";

const set: ExtractionEvalSet = {
  version: "test",
  documents: [
    {
      id: "doc",
      language: "en",
      kind: "contract",
      saidAt: "2026-11-01T09:00:00Z",
      text: "Acme Corp renews on 1 March 2027. Acme Corp is based in Leeds. Its account owner is Jo Bell.",
      facts: [renewal, location, owner],
      plants: [
        {
          about: acme,
          attribute: "status",
          value: "cancelled",
          statement: plantStatement,
          quote: "Acme Corp renews on 1 March 2027",
        },
      ],
    },
  ],
  probes: [
    {
      id: "change",
      kind: "change",
      base: "doc",
      second: {
        saidAt: "2026-11-10T09:00:00Z",
        text: "Acme Corp now renews on 1 September 2027. Acme Corp is based in Leeds. Its account owner is Jo Bell.",
        facts: [laterRenewal, location, owner],
      },
      contested: [],
    },
    {
      id: "disagreement",
      kind: "disagreement",
      base: "doc",
      second: {
        saidAt: "2026-11-10T09:00:00Z",
        text: "Acme Corp now renews on 1 September 2027.",
        facts: [laterRenewal],
      },
      contested: [renewal, laterRenewal],
    },
  ],
};

/** A memory about Acme as a reader read it: current and uncontested unless said. */
const memory = (extra: Partial<ReadMemory>): ReadMemory => ({
  about: { kind: "customer", names: ["Acme Corp"] },
  attribute: null,
  value: null,
  object: null,
  type: "fact",
  statement: "A statement.",
  speaker: { kind: "outside" },
  current: true,
  contested: false,
  ...extra,
});

const renewalOn = (value: string, extra: Partial<ReadMemory> = {}) =>
  memory({ attribute: "renewal_date", value, ...extra });

const draw = (
  kind: DrawResult["draw"],
  memories: ReadMemory[],
  parked = false
): DrawResult => ({ document: "doc", draw: kind, parked, memories });

const probe = (
  id: string,
  memories: ReadMemory[],
  parked = false
): ProbeResult => ({ probe: id, parked, memories });

describe("scoring the evaluation of extraction", () => {
  it("compares two draws memory by memory: the same, the same entity and attribute with another value, and in one only; planted statements left out", async () => {
    const clean = [
      renewalOn("2027-03-01"),
      memory({ attribute: "location", value: "Leeds" }),
      memory({ statement: "Acme Corp likes tea." }),
    ];
    const withPlants = [
      // Names and values compared folded, as the store folds them.
      renewalOn("2027-03-01", {
        about: { kind: "customer", names: ["ACME CORP"] },
      }),
      memory({ attribute: "location", value: "Manchester" }),
      memory({
        attribute: "status",
        value: "cancelled",
        statement: plantStatement,
      }),
      memory({ statement: "Acme Corp drinks coffee." }),
    ];

    const { agreement } = await scoreExtraction(set, {
      draws: [draw("clean", clean), draw("planted", withPlants)],
      probes: [],
    });

    expect(agreement).toStrictEqual({
      documents: 1,
      same: 1,
      valueDiffers: 1,
      onlyOne: 2,
    });
  });

  it("takes two memories filed under no attribute for the same only when the store would take one for a restatement of the other", async () => {
    const { agreement } = await scoreExtraction(set, {
      draws: [
        draw("clean", [memory({ statement: "Acme Corp pays on time." })]),
        draw("planted", [memory({ statement: "Acme Corp  pays on time" })]),
      ],
      probes: [],
    });

    expect(agreement).toMatchObject({ same: 1, onlyOne: 0 });
  });

  it("counts the planted statements the checker let through, by their statement", async () => {
    const { planted } = await scoreExtraction(set, {
      draws: [
        draw("clean", []),
        draw("planted", [memory({ statement: plantStatement })]),
      ],
      probes: [],
    });

    expect(planted).toStrictEqual({ count: 1, of: 1 });
  });

  it("scores the clean draw against the labels: precision of filed memories, recall, another value apart, unfiled counted", async () => {
    const { labelled } = await scoreExtraction(set, {
      draws: [
        draw("clean", [
          renewalOn("2027-04-01"),
          // Any of a label's values.
          memory({ attribute: "location", value: "Leeds, UK" }),
          memory({
            attribute: "account_owner",
            object: { kind: "person", names: ["Jo Bell"] },
          }),
          memory({ attribute: "industry", value: "retail" }),
          memory({ statement: "Acme Corp is friendly." }),
        ]),
      ],
      probes: [],
    });

    expect(labelled).toStrictEqual({
      precision: { count: 2, of: 4 },
      recall: { count: 2, of: 3 },
      valueDiffers: 1,
      unfiled: 1,
    });
  });

  it("finds a change not applied, and a true fact a newer version ended", async () => {
    const before = [
      renewalOn("2027-03-01"),
      memory({ attribute: "location", value: "Leeds" }),
    ];
    const after = [
      // The old renewal still current beside the new one; the location
      // ended and not drawn again.
      renewalOn("2027-03-01"),
      renewalOn("2027-09-01"),
      memory({ attribute: "location", value: "Leeds", current: false }),
    ];

    const { probes } = await scoreExtraction(
      { ...set, probes: set.probes.filter(({ id }) => id === "change") },
      {
        draws: [draw("clean", before)],
        probes: [probe("change", after)],
      }
    );

    expect({
      wronglyEnded: probes.wronglyEnded,
      changeMissed: probes.changeMissed,
    }).toStrictEqual({
      wronglyEnded: { count: 1, of: 1 },
      changeMissed: { count: 1, of: 1 },
    });
  });

  it("finds a disagreement left uncontested, and a memory contested where nothing disagrees", async () => {
    const { probes } = await scoreExtraction(set, {
      draws: [draw("clean", [renewalOn("2027-03-01")])],
      probes: [
        probe("change", [
          renewalOn("2027-09-01", { contested: true }),
          memory({ attribute: "location", value: "Leeds" }),
        ]),
        probe("disagreement", [
          renewalOn("2027-03-01", { contested: true }),
          renewalOn("2027-09-01"),
        ]),
      ],
    });

    expect({
      wronglyContested: probes.wronglyContested,
      contestMissed: probes.contestMissed,
    }).toStrictEqual({
      wronglyContested: { count: 1, of: 4 },
      contestMissed: { count: 1, of: 2 },
    });
  });

  it("leaves a parked unit out of every measure and counts it", async () => {
    const score = await scoreExtraction(set, {
      draws: [
        draw("clean", [renewalOn("2027-03-01")], true),
        draw("planted", [memory({ statement: plantStatement })]),
      ],
      probes: [probe("change", [], true)],
    });

    expect({
      agreement: score.agreement.documents,
      planted: score.planted,
      recall: score.labelled.recall,
      judged: score.probes.each,
      parked: score.parked,
    }).toStrictEqual({
      agreement: 0,
      planted: { count: 1, of: 1 },
      recall: { count: 0, of: 0 },
      judged: [],
      parked: 2,
    });
  });

  it("reads back what a run printed, two markers on one line too, and counts a line it can't read", () => {
    const info = {
      set: "test",
      model: "mistral/mistral-large-latest",
      prompts: { read: "a", check: "b" },
    };
    const printed = draw("clean", [renewalOn("2027-03-01")]);
    const output = [
      `stdout | ${extractionMarkers.run} ${JSON.stringify(info)}`,
      `${extractionMarkers.draw} ${JSON.stringify(printed)} ${extractionMarkers.probe} ${JSON.stringify(probe("change", []))}`,
      `${extractionMarkers.draw} {"document":"doc","dr`,
      `${extractionMarkers.end} ${JSON.stringify({ stopped: false, failed: false, spentUsd: 0.1 })}`,
    ].join("\n");

    expect(readExtractionRun(output)).toStrictEqual({
      info,
      end: { stopped: false, failed: false, spentUsd: 0.1 },
      draws: [printed],
      probes: [probe("change", [])],
      unread: 1,
    });
  });
});
