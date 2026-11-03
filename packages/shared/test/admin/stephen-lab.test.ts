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
  changes: Partial<Result> = {}
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
      talks: `talks-${version ?? "old"}`,
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
  interviews: readonly { version?: string; finished: boolean }[]
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
      startedAt: "2026-10-10T09:00:00.000Z",
      completedAt: each.finished ? "2026-10-10T09:30:00.000Z" : null,
      updatedAt: "2026-10-10T09:30:00.000Z",
      agreed: each.finished,
      phase: each.finished ? "readback" : "steps",
      stoppedAt: each.finished ? null : "steps",
      minutes: 30,
      facts: 10,
      out: 1,
      confirmed: each.finished ? 9 : 0,
      rating: each.finished ? 4 : null,
      typed: false,
      interviewer: "stephen",
      ...(each.version === undefined ? {} : { version: each.version }),
    })),
  });
  const { org, state } = adminOrgOf(snapshot, { ...client, name });
  return { clientId: name, name, view: viewOf(org, state) };
};

/** `count` interviews of `version`, `finished` of them finished. */
const held = (version: string | undefined, count: number, finished: number) =>
  Array.from({ length: count }, (_, at) => ({
    ...(version === undefined ? {} : { version }),
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
      version: "v2",
      before: { version: "v1", value: 0.6 },
      verdict: "better",
    });
    expect(
      lab.versions.map(({ version, name }) => [version, name])
    ).toStrictEqual([
      ["v1", "Stephen 1"],
      ["v2", "Stephen 2"],
    ]);
  });

  it("calls nothing better or worse when chance wasn't measured, or the change is within it", () => {
    expect(labOf([run("v1", [0.6]), run("v2", [0.8])]).headline?.verdict).toBe(
      "noise not measured"
    );
    expect(
      labOf([
        run("v1", [0.6]),
        run("v2", [0.62]),
        run("v2", [0.5]),
        run("v2", [0.74]),
      ]).headline?.verdict
    ).toBe("no difference");
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
      [organization("Bakkerij", [...held("v1", 10, 9), ...held("v2", 12, 6)])]
    );

    expect(lab.needs.map(({ text }) => text)).toStrictEqual([
      "12 interviews were held with a Stephen the lab never measured. Run the benches on that release.",
      "Fewer people finish with Not measured: 6 of 12, against 9 of 10 with Stephen 1.",
    ]);
  });
});

describe("a lab gone quiet", () => {
  it("is said after two weeks without a run", () => {
    const old = run("v1", [0.6], { at: "2026-10-01T09:00:00.000Z" });

    expect(labOf([old]).needs.map(({ id }) => id)).toStrictEqual(["quiet"]);
  });
});
