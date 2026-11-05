/** The bounds a definition's text and its declared stores are held to. */
export const profileLimits = {
  /** UTF-8 bytes of workflow.json. */
  maxDefinitionBytes: 1024 * 1024,
  /** Arrays and objects inside one another in the definition. */
  maxDefinitionDepth: 160,
  /** Values and object keys in the definition. */
  maxDefinitionValues: 250_000,
  /** Stores a workflow declares (stores.ts), and operations on each. */
  maxStores: 8,
  maxStoreOperations: 32,
} as const;
