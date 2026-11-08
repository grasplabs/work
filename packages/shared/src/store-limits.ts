// The shape of a business store's schema that both sides check: the SDK
// when an App declares its tables (`defineSchema`), and the store's host
// when it is handed a schema or a commit. Kept apart from stores.ts, and
// free of dependencies, because the SDK's root module (what pages import
// for `v`) can't bring Zod along.

/**
 * A table, field or index name: an ASCII letter, then letters, digits or
 * underscores. A field can't start with `_`, which keeps the managed
 * fields (`_id`, `_ownerId`, `_rev`, `_createdAt`, `_updatedAt`) apart
 * from authored ones.
 */
export const storeNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * A stable ID an App's definition gives a table or field, which never
 * changes: letters, digits and `:._-` only (Grasp's tools make UUIDs), as
 * a store writes a table's ID into SQL as a literal (partial indexes).
 */
export const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u;

/**
 * The longest table, field or index name: a name is typed in code and
 * carried in every query descriptor and error that names it, so this
 * keeps those short whatever a schema declares.
 */
export const storeNameMaxLength = 64;

/**
 * The most fields one index orders by. A page's seek binds two values per
 * index field and one for the record ID (34 at 16), which must fit
 * SQLite's 100 bound parameters a statement beside a query's own
 * (`queryMaxBoundValues`).
 */
export const indexMaxFields = 16;

/**
 * The most tables a store may define. Every live query's read set names
 * the tables it read with their generations, and a store keeps up to
 * `storeMaxWatches` of them in memory (store-watches.ts): this bounds each.
 */
export const storeMaxTables = 64;

/**
 * The most physical indexes a store holds for its declared indexes,
 * retained ones (for consumers pinned to older schemas) included. Every
 * write to a store's records evaluates every partial index's condition
 * and opens each index, whichever table it belongs to, so a write's cost
 * follows the store's total. Measured on SQLite 3.51 with 32 indexes on
 * the table written and N on others, an insert took 25 µs at N = 32,
 * 90 µs at 224, then 356 µs at 352 and 784 µs at 480: 256 keeps a write
 * before that cliff. Default-order reads use two fixed indexes instead.
 */
export const storeMaxIndexes = 256;

// The bounds of one read of a store (`ctx.db`). As Convex's, they are
// what one read may cost, by the records it examines and the bytes it
// reads (`queryMaxScannedEntries`, `queryMaxScannedBytes`), never how many
// records a feature may answer: `collect`, `take`, a page, a `group` or a
// `with` answer whatever those bounds let them read. The few others each
// name the failure they prevent. Checked by the SDK as a query is built
// and again by the store's host, which trusts no descriptor.

/** How many records a page holds when its caller doesn't say. */
export const queryDefaultPageSize = 50;

/**
 * The most bounds one index range holds: equality on every field but the
 * last, then a lower and an upper bound on the last. Not a choice: no
 * valid range on an index holds more.
 */
export const rangeMaxBounds = indexMaxFields + 1;

/**
 * How deeply a filter's `AND`, `OR` and `NOT` may nest: a filter is read
 * recursively once its size is checked, and becomes one SQL expression,
 * which SQLite refuses past a depth of 1000.
 */
export const filterMaxDepth = 8;

/**
 * The most conditions and logic nodes one filter holds, all told: SQLite
 * nests `a AND b AND c` one level per term, so a long flat filter is as
 * deep as it is long and would pass its 1000 levels.
 */
export const filterMaxNodes = 64;

/**
 * The most values a query's descriptor binds as SQL parameters: one per
 * condition with a value (an `in` binds its list as one JSON value), one
 * per range bound with a value. A Durable Object's SQLite binds at most
 * 100 parameters per statement, and the host adds its own: the owner (1)
 * and, for a page, a cursor's seek (at most two per index field and the
 * record ID, 34), which leaves 65; 64 keeps a bound to spare.
 */
export const queryMaxBoundValues = 64;

/**
 * The most index entries one terminal examines: a filter that must skip
 * more to answer, a `collect` of more, or a count or aggregate over more,
 * fails (`data.scan_limit`) rather than answering part. Longer work is a
 * workflow's, in pages. A terminal answers no more records than it
 * examines, so this also bounds what `take` and a page may ask for.
 */
export const queryMaxScannedEntries = 10_000;

/** The most bytes of documents (UTF-8 JSON) one terminal reads. */
export const queryMaxScannedBytes = 16 * 1024 * 1024;

/**
 * The longest a pagination cursor may be, in characters (spec 9.2: 4 KiB):
 * it travels in every page's arguments. A cursor whose last record's
 * values don't fit holds its ID alone (store-cursors.ts).
 */
export const cursorMaxLength = 4096;

// Full-text search: a search's work in SQLite's full-text index happens
// before the store counts what it examines, so it is bounded here.

/**
 * The most search indexes a store holds, retained ones (for consumers
 * pinned to older schemas) included: each keeps its own full-text table,
 * which every write to its table's records updates.
 */
export const storeMaxSearchIndexes = 64;

/**
 * The most words one search looks for, each of which must match: SQLite's
 * full-text index reads every word's whole list of matching rows before
 * the store examines the first match, outside `queryMaxScannedEntries`.
 */
export const searchMaxTerms = 8;
