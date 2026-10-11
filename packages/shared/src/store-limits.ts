// The shape of a business store's schema that both sides check: the SDK
// when an App declares its tables (`defineSchema`), and the store's host
// when it is handed a schema or a commit. Kept apart from stores.ts, and
// free of dependencies, because the SDK's root module (what screens import
// for `v`) can't bring Zod along.

/**
 * A table, field or index name: an ASCII letter, then letters, digits or
 * underscores. A field can't start with `_`, which keeps the managed
 * fields (`_id`, `_ownerId`, `_rev`, `_createdAt`, `_updatedAt`) apart
 * from authored ones.
 */
export const storeNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** The longest table, field or index name. */
export const storeNameMaxLength = 64;

/** The most fields one index orders by. */
export const indexMaxFields = 16;

/** The most tables a store may define. */
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

// The bounds of one read of a store (`ctx.db`): what a query's descriptor
// may hold, and what one terminal returns. Checked by the SDK as a query is
// built and again by the store's host, which trusts no descriptor. The
// host's own until the runtime policy module sets validated quotas, which
// may only lower them.

/** The most records `take`, `collect` and one page return. */
export const queryMaxResults = 100;

/** How many records a page holds when its caller doesn't say. */
export const queryDefaultPageSize = 50;

/** The longest string a range or filter compares with, in characters. */
export const queryMaxStringLength = 4096;

/**
 * The most bounds one index range holds: equality on every field but the
 * last, then a lower and an upper bound on the last.
 */
export const rangeMaxBounds = indexMaxFields + 1;

/** The most values one filter's `in` lists. */
export const filterMaxInValues = 100;

/** How deeply a filter's `AND`, `OR` and `NOT` may nest. */
export const filterMaxDepth = 8;

/** The most conditions and logic nodes one filter holds, all told. */
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

/** The longest a pagination cursor may be, in characters (spec 9.2: 4 KiB). */
export const cursorMaxLength = 4096;
