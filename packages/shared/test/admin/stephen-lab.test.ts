/**
 * The Stephen Lab worked out (stephen-lab.ts): the lab's runs and real
 * interviews side by side by the Stephen that held them, and what needs
 * one of us. How it can go wrong:
 *
 * - A change is called better or worse by chance, or set beside a run
 *   measured another way (other models, other people).
 * - A hidden case leaves the hidden set, or a hidden run's numbers are
 *   read as an open one's.
 * - Real interviews of one Stephen are counted for another, or ones that
 *   don't say which Stephen held them are counted for any.
 * - A drop in who finishes with a new Stephen goes unsaid.
 */
import { describe, expect, it } from "vite-plus/test";

import { adminSnapshotSchema } from "../../src/admin-snapshot.ts";
import { adminOrgOf } from "../../src/admin/admin-snapshot-adapter.ts";
import { viewOf } from "../../src/admin/onboarding-admin.ts";
import { stephenLabOf, UNRECORDED } from "../../src/admin/stephen-lab.ts";
import type { LabOrganization } from "../../src/admin/stephen-lab.ts";
import { scoresOf } from "../../src/lab-runs.ts";
import type { Result } from "../../src/lab-runs.ts";
import { answer, client } from "./fixtures/bakkerij.ts";

const now = "2026-11-03T12:00:00.000Z";
let made = 0;

/** A run of one bench on `values`, one case each, a minute after the one before. */
const run = (
  version: string | undefined,
  values: readonly number[],
  changes: Partial<Result> = {},
  talks = `talks-${version ?? "old"}`
): Result => {
  made += 1;
  const bench = changes.bench ?? "whole";
  const metric = bench === "ask" ? "right" : "heard";
  return {
    id: `run-${made}`,
    at: new Date(Date.UTC(2026, 10, 1, 9, made)).toISOString(),
    label: "round",
    bench,
    set: "open",
    stephen: {
      interviewer: "stephen",
      own: "own",
      lead: "lead",
      talks,
      draws: "draws",
      ...(version === undefined ? {} : { version }),
      commit: "abc1234",
    },
    via: { quick: "sonnet", careful: "opus" },
    people: "real",
    seed: 1,
    cases: values.map((value, at) => ({
      id: `case-${at}`,
      scores: { [metric]: value },
    })),
    spent: "nothing",
    ...changes,
  };
};

/**
 * An organization whose people each held one interview, as core's admin
 * snapshot says it: by which Stephen, and whether they finished.
 */
const organization = (
  name: string,
  interviews: readonly {
    version?: string;
    finished: boolean;
    locale?: string;
    typed?: boolean;
    /** When it started, and when it last moved, as ISO time. */
    on?: string;
    ended?: string;
  }[],
  channel?: string
): LabOrganization => {
  const people = interviews.map((_, at) => ({
    id: `p${at}`,
    name: `Person ${at}`,
    email: `p${at}@bakkerij.test`,
    team: "sales",
    title: "",
    away: false,
  }));
  const snapshot = adminSnapshotSchema.parse({
    ...answer,
    roster: { ...answer.roster, people: [...answer.roster.people, ...people] },
    interviews: interviews.map((each, at) => ({
      person: `p${at}`,
      kind: "own",
      startedAt: each.on ?? "2026-10-10T09:00:00.000Z",
      completedAt: each.finished
        ? (each.ended ?? "2026-10-10T09:30:00.000Z")
        : null,
      updatedAt: each.ended ?? "2026-10-10T09:30:00.000Z",
      agreed: each.finished,
      phase: each.finished ? "readback" : "steps",
      stoppedAt: each.finished ? null : "steps",
      minutes: 30,
      facts: 10,
      out: 1,
      confirmed: each.finished ? 9 : 0,
      rating: each.finished ? 4 : null,
      typed: each.typed ?? false,
      interviewer: "stephen",
      ...(each.version === undefined ? {} : { version: each.version }),
      ...(each.locale === undefined ? {} : { locale: each.locale }),
    })),
  });
  const { org, state } = adminOrgOf(snapshot, { ...client, name });
  return {
    clientId: name,
    name,
    view: viewOf(org, state),
    ...(channel === undefined ? {} : { channel }),
  };
};

/** `count` interviews of `version`, `finished` of them finished, in `locale`, started `on` and last moved `ended`. */
const held = (
  version: string | undefined,
  count: number,
  finished: number,
  locale?: string,
  on?: string,
  ended?: string
) =>
  Array.from({ length: count }, (_, at) => ({
    ...(version === undefined ? {} : { version }),
    ...(locale === undefined ? {} : { locale }),
    ...(on === undefined ? {} : { on }),
    ...(ended === undefined ? {} : { ended }),
    finished: at < finished,
  }));

const labOf = (
  results: readonly Result[],
  organizations: readonly LabOrganization[] = [],
  scores = results.filter((each) => each.set === "hidden").map(scoresOf)
) =>
  stephenLabOf({
    results: results.filter((each) => each.set === "open"),
    scores,
    organizations,
    interviewer: "stephen",
    now,
  });

describe("the number the Lab leads with", () => {
  it("says a change is real only when it is larger than what the newer Stephen moves by chance", () => {
    const lab = labOf([
      run("v1", [0.6, 0.6]),
      run("v1", [0.6, 0.6]),
      run("v2", [0.8, 0.8]),
      run("v2", [0.8, 0.78]),
    ]);

    expect(lab.headline).toMatchObject({
      label: "Heard",
      version: "talks-v2",
      before: { version: "talks-v1", value: 0.6 },
      verdict: "better",
    });
    expect(
      lab.versions.map(({ version, name }) => [version, name])
    ).toStrictEqual([
      ["talks-v1", "Stephen 1"],
      ["talks-v2", "Stephen 2"],
    ]);
  });

  it("calls nothing better or worse when chance wasn't measured, or the change is within what the earlier Stephen moves by", () => {
    expect(labOf([run("v1", [0.6]), run("v2", [0.8])]).headline?.verdict).toBe(
      "noise not measured"
    );
    // The earlier Stephen moves 20 points between two runs: ten points up is within that.
    expect(
      labOf([
        run("v1", [0.6]),
        run("v1", [0.8]),
        run("v2", [0.8]),
        run("v2", [0.8]),
      ]).headline?.verdict
    ).toBe("no difference");
  });

  it("compares two Stephens only over the cases both were measured on", () => {
    // The newer one was also run on an easy case the older one never saw: on the shared case nothing changed.
    const lab = labOf([
      run("v1", [0.5]),
      run("v1", [0.5]),
      run("v2", [0.5, 1]),
      run("v2", [0.5, 1]),
    ]);

    expect(lab.headline?.verdict).toBe("no difference");
  });

  it("tells a change to the code that makes him talk apart from his texts, and joins real interviews to the newest", () => {
    const lab = labOf(
      [run("v1", [0.6], {}, "talks-a"), run("v1", [0.7], {}, "talks-b")],
      [organization("Bakkerij", held("v1", 3, 3))]
    );

    expect(
      lab.versions.map(({ version, release, name, real }) => [
        version,
        release,
        name,
        real?.started ?? null,
      ])
    ).toStrictEqual([
      ["talks-a", "v1", "Stephen 1", null],
      ["talks-b", "v1", "Stephen 2", 3],
    ]);
  });

  it("never sets a version beside one measured with other models", () => {
    const lab = labOf([
      run("v1", [0.9], { via: { quick: "haiku", careful: "opus" } }),
      run("v2", [0.6]),
    ]);

    expect(lab.headline?.before).toBeNull();
    expect(lab.headline?.verdict).toBeNull();
  });

  it("says what the hidden companies say as a number, and warns when they don't back a change", () => {
    const lab = labOf([
      run("v1", [0.6, 0.6]),
      run("v1", [0.6, 0.6]),
      run("v1", [0.7], { set: "hidden" }),
      run("v2", [0.8, 0.8]),
      run("v2", [0.8, 0.8]),
      run("v2", [0.65], { set: "hidden" }),
    ]);

    expect(lab.headline?.hiddenChange).toBeCloseTo(-0.05);
    expect(lab.needs.map(({ id }) => id)).toContain("hidden");
    // Of a hidden run only its means and how many cases: never a case or its id.
    expect(
      JSON.stringify(lab.runs.filter((each) => each.set === "hidden"))
    ).not.toContain("case-0");
  });

  it("falls back to the next number when whole interviews never ran", () => {
    const lab = labOf([run("v1", [1, 0], { bench: "ask" })]);

    expect(lab.headline).toMatchObject({ label: "Right line", value: 0.5 });
  });
});

describe("real interviews by version", () => {
  it("counts each organization's interviews for the Stephen that held them, and the ones that don't say apart", () => {
    const lab = labOf(
      [run("v1", [0.6])],
      [
        organization("Bakkerij", [
          ...held("v1", 3, 2),
          ...held(undefined, 2, 1),
        ]),
        organization("Molen", held("v2", 4, 4)),
      ]
    );

    const real = Object.fromEntries(
      lab.versions.map(({ name, real: of }) => [
        name,
        of === null ? null : [of.organizations, of.finished, of.started],
      ])
    );
    expect(real).toStrictEqual({
      "Stephen 1": [1, 2, 3],
      "Not recorded": [1, 1, 2],
      "Not measured": [1, 4, 4],
    });
    expect([lab.real.finished, lab.real.started]).toStrictEqual([7, 9]);
    expect(
      lab.versions.find(({ version }) => version === UNRECORDED)?.lab
    ).toStrictEqual({});
  });

  it("says when fewer people finish with a newer Stephen, and when most talk with one the lab never measured", () => {
    const lab = labOf(
      [run("v1", [0.6])],
      [organization("Bakkerij", [...held("v1", 10, 10), ...held("v2", 12, 6)])]
    );

    expect(lab.needs.map(({ text }) => text)).toStrictEqual([
      "12 interviews were held with a Stephen the lab never measured. Run the benches on that release.",
      "Fewer people finish with Not measured: 6 of 12, against 10 of 10 with Stephen 1, more than chance.",
    ]);
  });
});

describe("live, group by group", () => {
  it("finds the language where fewer finish while the others hold, and says nothing for a group too small", () => {
    const lab = labOf(
      [run("v1", [0.6]), run("v2", [0.6])],
      [
        organization("Bakkerij", [
          ...held("v1", 10, 10, "nl"),
          ...held("v1", 10, 9, "en"),
          ...held("v2", 10, 3, "nl"),
          ...held("v2", 12, 11, "en"),
          ...held("v2", 3, 0, "de"),
        ]),
      ]
    );

    const groups = Object.fromEntries(
      (lab.live?.groups ?? []).map((group) => [group.label, group.finishedFell])
    );
    expect(lab.live?.now.name).toBe("Stephen 2");
    expect(lab.live?.before?.name).toBe("Stephen 1");
    expect(groups).toMatchObject({
      Dutch: true,
      English: false,
      German: false,
    });
  });

  it("counts every release one Stephen was run as", () => {
    const lab = labOf(
      [run("r1", [0.6], {}, "talks-s"), run("r2", [0.6], {}, "talks-s")],
      [organization("Bakkerij", [...held("r1", 3, 3), ...held("r2", 2, 1)])]
    );

    const all = lab.live?.groups.find((group) => group.id === "all");
    expect([all?.now.finished, all?.now.started]).toStrictEqual([4, 5]);
  });

  it("sets the Stephen in use against the one people started with before him, whatever order organizations come in or when each last moved", () => {
    // Molen started with v1 first, though its interviews last moved after Bakkerij's with v2.
    const older = organization(
      "Molen",
      held(
        "v1",
        10,
        10,
        undefined,
        "2026-10-08T09:00:00.000Z",
        "2026-10-13T09:30:00.000Z"
      )
    );
    const newer = organization(
      "Bakkerij",
      held(
        "v2",
        12,
        6,
        undefined,
        "2026-10-09T09:00:00.000Z",
        "2026-10-10T09:30:00.000Z"
      )
    );

    for (const organizations of [
      [older, newer],
      [newer, older],
    ]) {
      const lab = labOf([], organizations);
      expect([lab.live?.now.name, lab.live?.before?.name]).toStrictEqual([
        "Not measured",
        "Not measured",
      ]);
      expect(lab.needs.map(({ id }) => id)).toContain("finished-all");
    }
  });

  it("narrows real interviews to one release channel", () => {
    const lab = labOf(
      [run("v1", [0.6])],
      [
        organization("Bakkerij", held("v1", 4, 4), "edge"),
        organization("Molen", held("v1", 6, 3), "stable"),
      ]
    );
    const edge = stephenLabOf({
      results: [run("v1", [0.6])],
      scores: [],
      organizations: [
        organization("Bakkerij", held("v1", 4, 4), "edge"),
        organization("Molen", held("v1", 6, 3), "stable"),
      ],
      interviewer: "stephen",
      now,
      channel: "edge",
    });

    expect([lab.real.finished, lab.real.started]).toStrictEqual([7, 10]);
    expect([edge.real.finished, edge.real.started]).toStrictEqual([4, 4]);
  });
});

describe("one Stephen run as two releases", () => {
  it("keeps the real interviews of his earlier release with him when only Claire's texts changed", () => {
    const lab = labOf(
      [run("r1", [0.6], {}, "talks-s"), run("r2", [0.6], {}, "talks-s")],
      [organization("Bakkerij", held("r1", 3, 3))]
    );

    expect(
      lab.versions.map(({ name, real }) => [name, real?.started ?? null])
    ).toStrictEqual([["Stephen 1", 3]]);
    expect(lab.needs).toStrictEqual([]);
  });
});

describe("a lab gone quiet", () => {
  it("is said after two weeks without a run", () => {
    const old = run("v1", [0.6], { at: "2026-10-01T09:00:00.000Z" });

    expect(labOf([old]).needs.map(({ id }) => id)).toStrictEqual(["quiet"]);
  });
});
