import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { writeVersion } from "../src/documents.ts";
import { runLinking } from "../src/entities.ts";
import type { IndexStep } from "../src/indexing.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// E13 (the Brain design's research programme), the linking half: how well
// linking turns a model's mentions into entities, measured on a small
// labelled set. The model's answers are fixed, noise included, as a real
// model gives them: a name the text doesn't hold, an address pinned on two
// people, a team named two ways, a bare name two people share. Each
// mention has the entity it truly is; the measures are
// - precision: of the pairs of linked mentions given one entity, how many
//   truly are one;
// - coverage: of the true mentions, how many are linked at all;
// - false merges: entities given mentions of more than one true entity;
// - splits: true entities spread over more than one entity.
// No vectors and no hybrid baseline (parked): this measures identity, not
// recall.

const suffix = crypto.randomUUID().slice(0, 8);
const at = (local: string, domain: string) =>
  `${local}@${domain}-${suffix}.test`;

const annaAcme = at("anna.jansen", "acme");
const annaGlobex = at("anna.j", "globex");
const bram = at("bram", "acme");
const payrollDesk = at("payroll", "acme");

/** One document of the set: its text, the model's answer, and the truth. */
interface Case {
  path: string;
  text: string;
  answer: { kind: string; name: string; identifiers?: string[] }[];
  /** The true entity of each name the text holds, by the name. */
  truth: Record<string, string>;
}

const cases: Case[] = [
  {
    path: "onboarding.md",
    text: `Anna Jansen (${annaAcme}) owns Onboarding with Finance.`,
    answer: [
      { kind: "person", name: "Anna Jansen", identifiers: [annaAcme] },
      { kind: "process", name: "Onboarding" },
      { kind: "team", name: "Finance" },
    ],
    truth: {
      "Anna Jansen": "anna-acme",
      Onboarding: "onboarding",
      Finance: "finance",
    },
  },
  {
    path: "audit.md",
    text: `Anna Jansen <${annaGlobex}> from Globex audits Payroll.`,
    answer: [
      { kind: "person", name: "Anna Jansen", identifiers: [annaGlobex] },
      { kind: "organization", name: "Globex" },
      { kind: "process", name: "Payroll" },
    ],
    truth: {
      "Anna Jansen": "anna-globex",
      Globex: "globex",
      Payroll: "payroll",
    },
  },
  {
    path: "payroll.md",
    text: `Bram Visser (${bram}) runs Payroll for Finance.`,
    answer: [
      { kind: "person", name: "Bram Visser", identifiers: [bram] },
      { kind: "process", name: "Payroll" },
      { kind: "team", name: "Finance" },
    ],
    truth: { "Bram Visser": "bram", Payroll: "payroll", Finance: "finance" },
  },
  {
    path: "name-change.md",
    text: `Bram de Wit (${bram}), formerly Bram Visser, changed his name.`,
    answer: [
      { kind: "person", name: "Bram de Wit", identifiers: [bram] },
      { kind: "person", name: "Bram Visser" },
    ],
    truth: { "Bram de Wit": "bram", "Bram Visser": "bram" },
  },
  {
    path: "laptops.md",
    text: "Onboarding starts on Monday; Finance prepares the laptops.",
    answer: [
      { kind: "process", name: "Onboarding" },
      { kind: "team", name: "Finance" },
      // Not in the text: dropped.
      { kind: "person", name: "Carla Mendes" },
    ],
    truth: { Onboarding: "onboarding", Finance: "finance" },
  },
  {
    path: "offsite.md",
    // Which Anna? The text doesn't say: it must stay a proposal.
    text: "Anna Jansen will present at the offsite.",
    answer: [{ kind: "person", name: "Anna Jansen" }],
    truth: { "Anna Jansen": "anna-acme" },
  },
  {
    path: "closing.md",
    // An address for the process: a new entity (a split), and from then on
    // a bare "Payroll" is ambiguous.
    text: `Payroll closes on the 25th; write to ${payrollDesk}.`,
    answer: [{ kind: "process", name: "Payroll", identifiers: [payrollDesk] }],
    truth: { Payroll: "payroll" },
  },
  {
    path: "meeting.md",
    // The model pins Bram's address on Anna too: claimed twice, it
    // identifies neither.
    text: `Anna Jansen met Bram Visser (${bram}) about Onboarding.`,
    answer: [
      { kind: "person", name: "Anna Jansen", identifiers: [bram] },
      { kind: "person", name: "Bram Visser", identifiers: [bram] },
      { kind: "process", name: "Onboarding" },
    ],
    truth: {
      "Anna Jansen": "anna-acme",
      "Bram Visser": "bram",
      Onboarding: "onboarding",
    },
  },
  {
    path: "budget.md",
    text: "The Finance team owns the budget for Payroll.",
    answer: [
      { kind: "team", name: "the Finance team" },
      { kind: "process", name: "Payroll" },
    ],
    truth: { "the Finance team": "finance", Payroll: "payroll" },
  },
  {
    path: "globex.md",
    text: `Globex signed; Anna Jansen (${annaGlobex}) leads it.`,
    answer: [
      { kind: "organization", name: "Globex" },
      { kind: "person", name: "Anna Jansen", identifiers: [annaGlobex] },
    ],
    truth: { Globex: "globex", "Anna Jansen": "anna-globex" },
  },
];

const once: IndexStep = { do: async (_name, _config, fn) => await fn() };

/** `value` to three decimals. */
const rounded = (value: number) => Math.round(value * 1000) / 1000;

/** How many pairs `size` items make. */
const pairs = (size: number): number => (size * (size - 1)) / 2;

describe("entity linking quality (E13)", () => {
  it("measures precision, coverage, false merges and splits on the labelled set", async () => {
    const host = testHost(async (text) => {
      await Promise.resolve();
      return { entities: cases.find((one) => one.text === text)?.answer ?? [] };
    });
    const collection = await newCollection(host.brain, "Company");
    const sources = new Map<string, Case>();
    for (const one of cases) {
      // oxlint-disable-next-line no-await-in-loop -- in order: a name is resolved by what came before
      const saved = await writeVersion(host.brain, writerOf("writer"), {
        collection,
        path: one.path,
        text: one.text,
        ifVersion: 0,
        message: null,
        restoredFrom: null,
      });
      sources.set(`doc:${saved.id}`, one);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await runLinking(
        host.brain,
        { source: `doc:${saved.id}`, version: 1 },
        once
      );
    }
    // The measure reads the mentions as stored: not a behaviour under test.
    const { results } = await env.BRAIN.prepare(
      "SELECT source, name, entity_id AS entityId, state FROM brain_mentions WHERE source IN (SELECT value FROM json_each(?))"
    )
      .bind(JSON.stringify([...sources.keys()]))
      .all<{
        source: string;
        name: string;
        entityId: string | null;
        state: string;
      }>();
    const truthOf = ({ source, name }: { source: string; name: string }) =>
      sources.get(source)?.truth[name];
    const all = cases.flatMap(({ truth }) => Object.keys(truth)).length;
    const linked = results.filter(
      (row) => row.state === "linked" && truthOf(row) !== undefined
    );
    const byEntity = new Map<string, string[]>();
    const byTruth = new Map<string, Set<string>>();
    for (const row of linked) {
      const truth = truthOf(row) ?? "";
      const entityId = row.entityId ?? "";
      byEntity.set(entityId, [...(byEntity.get(entityId) ?? []), truth]);
      byTruth.set(truth, (byTruth.get(truth) ?? new Set()).add(entityId));
    }
    let predicted = 0;
    let correct = 0;
    for (const truths of byEntity.values()) {
      predicted += pairs(truths.length);
      const counts = new Map<string, number>();
      for (const truth of truths) {
        counts.set(truth, (counts.get(truth) ?? 0) + 1);
      }
      for (const count of counts.values()) {
        correct += pairs(count);
      }
    }

    expect({
      mentions: all,
      stored: results.length,
      invented: results.filter((row) => truthOf(row) === undefined).length,
      linked: linked.length,
      ambiguous: results.filter((row) => row.state === "ambiguous").length,
      precision: rounded(correct / predicted),
      coverage: rounded(linked.length / all),
      falseMerges: [...byEntity.values()].filter(
        (truths) => new Set(truths).size > 1
      ).length,
      splits: [...byTruth.values()].filter((ids) => ids.size > 1).length,
    }).toStrictEqual({
      mentions: 22,
      stored: 22,
      invented: 0,
      linked: 18,
      // Which Anna (twice: once bare, once with an address claimed twice),
      // which Payroll once the desk's address made a second one, and Bram
      // under his new name: an address another name holds is proposed.
      ambiguous: 4,
      precision: 1,
      coverage: 0.818,
      falseMerges: 0,
      splits: 2,
    });
  });
});
