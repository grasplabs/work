import { describe, expect, it } from "vite-plus/test";

import {
  forbiddenIn,
  sealedDigest,
  suiteDigest,
  tasksOf,
} from "./brain-harness.ts";
import { normalized } from "./brain-scoring.ts";
import {
  brainDocuments,
  brainLanguages,
  brainMemories,
  brainUpdates,
  brainWindows,
} from "./fixtures/brain-corpus.ts";
import type { BrainWindow } from "./fixtures/brain-corpus.ts";
import {
  brainAdmissionProbes,
  brainFamilies,
  brainSealedDigests,
  brainSuiteDigests,
  brainSplits,
  brainSuiteVersion,
  brainTasks,
} from "./fixtures/brain-tasks.ts";
import type { BrainTask } from "./fixtures/brain-tasks.ts";

// The Brain baseline's suite keeps its own rules, so a result can be
// trusted as transfer evidence: related variants stay in one split, sealed
// cases ask about entities nothing else asks about and can't change within
// a suite version, every family and language is covered, and every
// expected piece of evidence is really in the corpus when its task runs.

/** A document's text at the start of `window`, after that window's updates. */
const textAt = (path: string, window: BrainWindow): string | undefined => {
  const entry = Object.entries(brainDocuments).find(
    ([, document]) => document.path === path
  );
  if (entry === undefined) {
    return undefined;
  }
  const [key, document] = entry;
  let text: string = document.text;
  const until = brainWindows.indexOf(window);
  for (const update of brainUpdates) {
    if (
      update.document === key &&
      brainWindows.indexOf(update.window) <= until
    ) {
      if (update.type === "save") {
        ({ text } = update);
      } else {
        for (const term of update.terms) {
          text = text.replaceAll(term, "");
        }
      }
    }
  }
  return text;
};

/** Where `task` expects its evidence, and whether the marker is there. */
const evidenceIn = (task: BrainTask) =>
  task.expect.kind === "abstain"
    ? []
    : task.expect.evidence.map(({ source, marker }) => {
        const [path = ""] = source.split("#");
        let text: string | undefined;
        if (source === "memory") {
          text = brainMemories[task.persona];
        } else if (source === "session") {
          text = (task.priorTurns ?? []).join("\n");
        } else {
          text = textAt(path, task.window);
        }
        return {
          task: task.id,
          source,
          found: normalized(text ?? "").includes(normalized(marker)),
        };
      });

/** The documents the answer tasks in or out of the sealed split ask about. */
const answeredIn = (sealed: boolean) =>
  new Set(
    brainTasks
      .filter(
        ({ split, expect: expected }) =>
          (split === "sealed") === sealed && expected.kind === "answer"
      )
      .flatMap(({ documents }) => documents)
  );

describe("the Brain baseline's suite", () => {
  it("keeps each group of related tasks in one split, and every task ID once", () => {
    const splitsOf = new Map<string, Set<string>>();
    for (const { group, split } of brainTasks) {
      splitsOf.set(group, new Set([...(splitsOf.get(group) ?? []), split]));
    }
    const ids = brainTasks.map(({ id }) => id);
    expect({
      spanning: [...splitsOf].filter(([, splits]) => splits.size > 1),
      duplicated: ids.filter((id, index) => ids.indexOf(id) !== index),
    }).toStrictEqual({ spanning: [], duplicated: [] });
  });

  it("asks its sealed answers about documents no other split asks about", () => {
    const elsewhere = answeredIn(false);
    expect(
      [...answeredIn(true)].filter((document) => elsewhere.has(document))
    ).toStrictEqual([]);
  });

  it("covers every family in the dev split and all five languages in every split", () => {
    const dev = new Set(tasksOf("dev").map(({ family }) => family));
    const languages = brainSplits.map((split) => [
      split,
      brainLanguages.filter(
        (language) =>
          !brainTasks.some(
            (task) => task.split === split && task.language === language
          )
      ),
    ]);
    expect({
      families: brainFamilies.filter((family) => !dev.has(family)),
      languages,
      probes: brainLanguages.filter(
        (language) =>
          !brainAdmissionProbes.some((probe) => probe.language === language)
      ),
    }).toStrictEqual({
      families: [],
      languages: brainSplits.map((split) => [split, []]),
      probes: [],
    });
  });

  it("expects only evidence that is in the corpus when its task runs", () => {
    const evidence = brainTasks.flatMap((task) => evidenceIn(task));
    expect({
      checked: evidence.length > brainTasks.length,
      missing: evidence.filter(({ found }) => !found),
    }).toStrictEqual({ checked: true, missing: [] });
  });

  it("runs its sealed split only when opened on purpose, and can't change it, its documents or the suite within a version", async () => {
    expect({
      closed: (() => {
        try {
          tasksOf("sealed");
          return "ran";
        } catch {
          return "refused";
        }
      })(),
      opened: tasksOf("sealed", { openSealed: true }).length,
      digest: await sealedDigest(),
      suite: await suiteDigest(),
    }).toStrictEqual({
      closed: "refused",
      opened: brainTasks.filter(({ split }) => split === "sealed").length,
      digest: brainSealedDigests[brainSuiteVersion],
      suite: brainSuiteDigests[brainSuiteVersion],
    });
  });

  it("forbids every restricted document's facts, not only its canary, to whoever may not read it", () => {
    const restricted = Object.values(brainDocuments).filter(
      (document) => "canary" in document
    );
    const open = Object.values(brainDocuments).filter(
      (document) => !("canary" in document)
    );
    const outsiders = brainTasks.filter(
      ({ expect: expected }) => expected.kind === "abstain"
    );
    expect({
      // Each one's facts are in its own words, and no open document and
      // no question holds them.
      notInText: restricted.flatMap((document) =>
        (document.restricted ?? []).filter(
          (fact) => !document.text.includes(fact)
        )
      ),
      elsewhere: restricted.flatMap((document) =>
        (document.restricted ?? []).filter(
          (fact) =>
            open.some(({ text }) => text.includes(fact)) ||
            brainTasks.some(({ question }) => question.includes(fact))
        )
      ),
      // An outsider's task forbids them.
      forbidden: outsiders
        .filter(({ id }) => id === "dev-route-plan-outsider")
        .map((task) => forbiddenIn(task).includes("05:30 from Tilburg")),
    }).toStrictEqual({
      notInText: [],
      elsewhere: [],
      forbidden: [true],
    });
  });

  it("forbids what a correction or a later owner replaced, so a stale version can't pass", () => {
    const missing = brainTasks.filter((task) => {
      if (
        task.family !== "correction" &&
        task.family !== "historical-ownership"
      ) {
        return false;
      }
      // The text the task's window removed from its documents.
      const removed = task.documents.flatMap((key) => {
        const { path } = brainDocuments[key];
        const at = brainWindows.indexOf(task.window);
        const before =
          at === 0 ? undefined : textAt(path, brainWindows[at - 1] ?? "t0");
        const now = textAt(path, task.window) ?? "";
        return (before ?? "")
          .split("\n")
          .filter((line) => line !== "" && !now.includes(line));
      });
      return (
        removed.length > 0 &&
        !(task.mustNotReach ?? []).some((stale) =>
          removed.some((line) => line.includes(stale))
        )
      );
    });
    expect(missing.map(({ id }) => id)).toStrictEqual([]);
  });
});
