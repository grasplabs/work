/**
 * Where the extractor's module is among core's static assets
 * (build-extractor.ts writes it, extract.ts reads it).
 */
export const extractorAsset = "_extractor/extractor.js";

/**
 * The name the file goes by as the sandbox host's extractor reads it a
 * chunk at a time (`extractRead`): its one part.
 */
export const extractedPart = "file";
