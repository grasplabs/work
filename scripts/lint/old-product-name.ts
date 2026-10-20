/**
 * The product's old name, in text a client or buyer reads: the product is
 * Grasp Work (GRA-143). Code names keep `grasp-os` (packages, accounts,
 * bindings, routes), which this never matches: it wants the two words
 * apart, as a person writes them. Returns what it found, or `undefined`.
 */
const oldName = /\bgrasp\s+os\b/iu;

export const findOldProductName = (text: string): string | undefined =>
  oldName.exec(text)?.[0];
