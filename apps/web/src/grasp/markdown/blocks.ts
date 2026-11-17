// An answer still being written, read a block at a time. Reading the whole answer again for every
// few words that arrive costs more the longer it gets. But only its last block can still change:
// the blocks before it are finished. So they are kept as they were read, with the source they were
// read from, and only what follows them is read again.
//
// A link or a note that is defined further down the answer is words until the answer is whole
// (then it is read whole, once), as it was before its definition had arrived.
import { parse } from "./parse";
import type { RootContent } from "./types";

/** A block of the answer, and where it starts in the source: its nodes' places count from there. */
export interface Placed {
  node: RootContent;
  base: number;
}

/** The blocks that are finished, and the source they were read from. */
export interface Kept {
  text: string;
  blocks: Placed[];
}

export const NOTHING: Kept = { text: "", blocks: [] };

/**
 * The blocks of `shown`, given what was kept from reading less of it, and what to keep now. `kept`
 * comes back as it was given when nothing more is finished.
 */
export const readBlocks = (
  shown: string,
  kept: Kept
): { blocks: Placed[]; kept: Kept } => {
  // Other words than those kept (a new answer in the same place): start again.
  const held = shown.startsWith(kept.text) ? kept : NOTHING;
  const base = held.text.length;
  const tail = shown.slice(base);
  const read = parse(tail).children.map((node) => ({ node, base }));
  const blocks = [...held.blocks, ...read];
  const cut = read.at(-1)?.node.position?.start.offset;
  // Every block but the last is finished: kept, with the source up to where the last starts.
  if (read.length > 1 && cut !== undefined && cut > 0) {
    return {
      blocks,
      kept: {
        text: held.text + tail.slice(0, cut),
        blocks: [...held.blocks, ...read.slice(0, -1)],
      },
    };
  }
  return { blocks, kept: held };
};
