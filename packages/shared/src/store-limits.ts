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

/** The most tables a store may define. */
export const storeMaxTables = 64;
