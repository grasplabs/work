// How deep a value may nest, apart and with nothing imported: the SDK's
// value checks and the limits on the Cap'n Web wire (screen-limits.ts)
// both start from it, and the screen runtime carries only what it uses.

/**
 * How many levels a value may nest, its leaf included: 32 levels are 31
 * arrays or objects around a leaf. A descriptor nests as deep, and so a
 * value is read as deep (the SDK's `valueLimits.depth`).
 */
export const valueDepth = 32;
