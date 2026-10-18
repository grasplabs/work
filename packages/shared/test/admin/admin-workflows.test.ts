import { describe, expect, it } from "vite-plus/test";

import { adminViewOf } from "../../src/admin/admin-view.ts";
import { standingOf, workflowListOf } from "../../src/admin/admin-workflows.ts";
import type { OrgView } from "../../src/admin/onboarding-admin.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp, , hartog] = SAMPLE_ORGS;
const day = "2026-10-02";
const noordkadeView = adminViewOf(noordkade, noordkade.seed, day);

describe("an organization's workflows", () => {
  it("groups each piece of work by how far it is known", () => {
    const [work] = noordkadeView.works;
    if (!work) {
      throw new Error("Noordkade's sample has no work");
    }
    const standings = (
      ["mapping", "saturating", "complete", "variants", "blocked"] as const
    ).map((state) => standingOf({ ...work, state }));

    expect(standings).toStrictEqual([
      "mapping",
      "nearly",
      "known",
      "known",
      "blocked",
    ]);
  });

  it("lists every piece of work in the organization's order, with how many are known and what is still missing", () => {
    const list = workflowListOf(noordkadeView);

    expect({
      works: list.rows.map((row) => row.work.id),
      counts: list.counts,
      known: list.known,
      mapping: list.mapping,
      missing: list.missing,
      papers: list.rows
        .filter((row) => row.work.id === "papers")
        .map(({ standing, missing }) => ({ standing, missing })),
      intake: list.rows.find((row) => row.work.id === "intake")?.missing,
    }).toStrictEqual({
      works: noordkadeView.works.map((work) => work.id),
      counts: { blocked: 0, mapping: 15, nearly: 0, known: 5 },
      known: 5,
      mapping: 15,
      missing: 32,
      papers: [{ standing: "known", missing: 1 }],
      intake: 5,
    });
  });

  it("counts work held up by a difference nobody can explain as still being mapped, not known", () => {
    const view: OrgView = {
      ...noordkadeView,
      works: noordkadeView.works.map((work) =>
        work.id === "papers" ? { ...work, state: "blocked" } : work
      ),
    };

    const list = workflowListOf(view);

    expect({
      counts: list.counts,
      known: list.known,
      mapping: list.mapping,
    }).toStrictEqual({
      counts: { blocked: 1, mapping: 15, nearly: 0, known: 4 },
      known: 4,
      mapping: 16,
    });
  });

  it("finds nothing missing in work that everyone has described", () => {
    const list = workflowListOf(adminViewOf(hartog, hartog.seed, day));

    expect({
      known: list.known,
      all: list.rows.length,
      quotes: list.rows.find((row) => row.work.id === "quotes")?.missing,
    }).toStrictEqual({ known: 11, all: 11, quotes: 0 });
  });

  it("has nothing to list before a team's work is named", () => {
    const list = workflowListOf(adminViewOf(veldkamp, veldkamp.seed, day));

    expect(list).toStrictEqual({
      rows: [],
      counts: { blocked: 0, mapping: 0, nearly: 0, known: 0 },
      known: 0,
      mapping: 0,
      missing: 0,
    });
  });
});
