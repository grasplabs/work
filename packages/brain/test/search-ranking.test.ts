import { describe, expect, it } from "vite-plus/test";

import { writeVersion } from "../src/documents.ts";
import { recall } from "../src/recall.ts";
import type { Caller } from "./host.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// A reader's results rank on what they may read alone (GRA-1083). BM25
// weighs each word by how many sections of the whole index hold it, those
// of collections the reader can't read too, so the order of a reader's
// own results moved with what those hold: a probe of how often a word is
// in collections hidden from them. Tried below: the same reader, the same
// query, before and after a hidden collection fills with one of its words.

const { brain } = testHost();

/** Saves `text` at `path` in `collection`. */
const saved = async (
  collection: Awaited<ReturnType<typeof newCollection>>,
  path: string,
  text: string
) =>
  await writeVersion(brain, writerOf("writer"), {
    collection,
    path,
    text,
    ifVersion: 0,
    message: null,
    restoredFrom: null,
  });

describe("ranking a reader's results", () => {
  it("keeps the order of a reader's results whatever a collection they can't read holds", async () => {
    const mine = await newCollection(brain, "Mine");
    const hidden = await newCollection(brain, "Hidden");
    // Two sections alike but for one word each: under BM25 the rarer of
    // the two words ranks its section first.
    const marker = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const first = `zqalpha${marker}`;
    const second = `zqbravo${marker}`;
    const one = await saved(mine, "one.md", `# Notes\nThe ${first} report.`);
    const two = await saved(mine, "two.md", `# Notes\nThe ${second} report.`);
    const reader: Caller = { userId: "ann", reads: [mine.id] };
    const query = `${first} ${second}`;

    // A recall matches any of its words, as section search's ranking
    // does for every reader of the index.
    const ordered = async () => {
      const pack = await recall(brain, reader, { query });
      return {
        recall: pack.items.flatMap(({ sourceRefs }) =>
          sourceRefs.flatMap((ref) =>
            ref.kind === "document" ? [ref.documentId] : []
          )
        ),
      };
    };
    const before = await ordered();
    // The hidden collection fills with the word of the section ranked
    // first: under BM25 that word grows common, and the other section
    // takes its place.
    const word = before.recall[0] === one.id ? first : second;
    for (let index = 0; index < 20; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await saved(hidden, `${word}-${index}.md`, `# Hidden\n${word} ${word}.`);
    }
    const after = await ordered();

    expect({
      after,
      both: new Set(before.recall),
    }).toStrictEqual({ after: before, both: new Set([one.id, two.id]) });
  });

  it("puts a section that holds more of the words before a shorter one that holds fewer", async () => {
    const mine = await newCollection(brain, "Long and short");
    const marker = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const first = `zqcharlie${marker}`;
    const second = `zqdelta${marker}`;
    const filler = "Plain words about nothing in particular. ".repeat(40);
    const long = await saved(
      mine,
      "long.md",
      `# Notes\nThe ${first} and ${second} report. ${filler}`
    );
    const short = await saved(
      mine,
      "short.md",
      `# Notes\nThe ${first} report.`
    );
    const reader: Caller = { userId: "ann", reads: [mine.id] };

    const pack = await recall(brain, reader, { query: `${first} ${second}` });
    const found = pack.items.flatMap(({ sourceRefs }) =>
      sourceRefs.flatMap((ref) =>
        ref.kind === "document" ? [ref.documentId] : []
      )
    );

    expect(found).toStrictEqual([long.id, short.id]);
  });
});
