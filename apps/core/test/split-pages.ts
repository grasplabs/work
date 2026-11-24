// A page with an end read as a live list reads it (`usePaginatedQuery`):
// on a `splitCursor`, it follows the page's two halves instead, each of
// which may split again, and shows only what they answer.

/** What one read of a page with an end answers. */
export interface SplitPage<Item> {
  readonly items: readonly Item[];
  readonly splitCursor?: string | undefined;
}

/** Reads the page from `from` to `end`. */
export type PageRead<Item> = (
  from: string | null,
  end: string
) => Promise<SplitPage<Item>>;

/** More reads than any page in these tests splits into. */
const maxReads = 500;

/** Every record a list's page `(from, end)` shows, and how many reads it took. */
export interface Tiled<Item> {
  readonly items: Item[];
  readonly reads: number;
}

const tile = async <Item>(
  read: PageRead<Item>,
  from: string | null,
  end: string,
  reads: { count: number }
): Promise<Item[]> => {
  reads.count += 1;
  if (reads.count > maxReads) {
    throw new Error(`the page split into more than ${maxReads} reads`);
  }
  const page = await read(from, end);
  if (page.splitCursor === undefined) {
    return [...page.items];
  }
  // Its first half, `(from, split)`, then the rest, `(split, end)`: the
  // answer that said to split may hold records past the split, which the
  // second half shows instead.
  const first = await tile(read, from, page.splitCursor, reads);
  const rest = await tile(read, page.splitCursor, end, reads);
  return [...first, ...rest];
};

/**
 * Every record the page from `from` to `end` shows once a live list has
 * followed each split it said to make.
 */
export const tiledPage = async <Item>(
  read: PageRead<Item>,
  from: string | null,
  end: string
): Promise<Tiled<Item>> => {
  const reads = { count: 0 };
  const items = await tile(read, from, end, reads);
  return { items, reads: reads.count };
};
