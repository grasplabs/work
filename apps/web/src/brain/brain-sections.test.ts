import { describe, expect, it } from "vite-plus/test";

import {
  brainSections,
  findFolder,
  noteGroups,
  onlyGroups,
  sectionOf,
} from "./brain-sections.ts";
import { buildBrain, countNotes, folderTree } from "./brain.ts";
import type { Folder, Note } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// The prototype's tests of the brain's parts
// (`components/brain-sections.test.ts`), on the small made-up company.

const keys = (folder: Folder): string[] => [
  folder.key,
  ...folder.folders.flatMap(keys),
];

/** Pages of folders inside a part that only hold groups: they step aside, since those groups are on the page anyway. */
const stepAside = (folder: Folder): number =>
  (onlyGroups(folder) && folder.note ? 1 : 0) +
  folder.folders.reduce((sum, child) => sum + stepAside(child), 0);

describe("the parts of the brain", () => {
  const brain = buildBrain(testWorkspace());
  const tree = folderTree(brain.notes);
  const note = (id: string): Note => {
    const found = brain.notes.find((candidate) => candidate.id === id);
    if (!found) {
      throw new Error(`No note ${id}`);
    }
    return found;
  };
  const folderAt = (key: string): Folder => {
    const found = findFolder(tree, key);
    if (!found) {
      throw new Error(`No folder ${key}`);
    }
    return found;
  };

  it("open onto folders that exist, so no part goes missing when a folder is renamed", () => {
    const present = new Set(keys(tree));
    expect(
      brainSections
        .map((section) => section.key)
        .filter((key) => !present.has(key))
    ).toStrictEqual([]);
  });

  it("show every note of a part on its page exactly once, however its groups fold together", () => {
    const counts = brainSections.map((section) => {
      const folder = folderAt(section.key);
      const shown = noteGroups(folder).flatMap((group) => [
        ...(group.page ? [group.page.id] : []),
        ...group.notes.map((each) => each.id),
      ]);
      return {
        part: section.slug,
        shown: shown.length,
        distinct: new Set(shown).size,
        held:
          countNotes(folder) -
          folder.folders.reduce((sum, child) => sum + stepAside(child), 0),
      };
    });
    expect(counts).toStrictEqual(
      counts.map((each) => ({ ...each, shown: each.held, distinct: each.held }))
    );
  });

  it("know which part a note sits in, from its folders", () => {
    expect(sectionOf(note("team-service"))?.slug).toBe("teams");
    expect(sectionOf(note("vision"))?.slug).toBe("vision");
    expect(sectionOf(note("src-service"))?.slug).toBe("sources");
    expect(sectionOf(note("company"))).toBeUndefined();
  });
});
