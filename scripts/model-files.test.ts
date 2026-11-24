import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

// A cache of this file's own, set before the module reads where it is.
process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), "model-cache-"));
const {
  cachedModelFile,
  isCached,
  keepFromDir,
  modelCacheDir,
  parseModelListing,
} = await import("./model-files.ts");
mkdirSync(modelCacheDir, { recursive: true });

/** A model file of random bytes, in a folder of its own, as an export writes one. */
const exported = (): {
  dir: string;
  file: { sha256: string; size: number };
} => {
  const dir = mkdtempSync(path.join(tmpdir(), "model-export-"));
  const bytes = randomBytes(4 * 1024 * 1024);
  writeFileSync(path.join(dir, "tokens-int8.bin"), bytes);
  return {
    dir,
    file: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    },
  };
};

// How CI's cache finds every model file in the releases bucket
// (`vp run model-files --all`): a page of R2's ListObjectsV2, as R2 answers
// one, read for each model file's SHA-256 and size and the next page.

const sha = (digit: string): string => digit.repeat(64);

const listing = (contents: string[], next?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>releases</Name><Prefix>blobs/models/</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${next === undefined ? "false" : "true"}</IsTruncated>${contents.join("")}${next === undefined ? "" : `<NextContinuationToken>${next}</NextContinuationToken>`}</ListBucketResult>`;

const entry = (key: string, size: number): string =>
  `<Contents><Key>${key}</Key><LastModified>2026-11-16T15:30:00.000Z</LastModified><ETag>"e"</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;

describe("the releases bucket's model files, as listed", () => {
  it("reads each model file's SHA-256 and size, skipping other keys, and the next page's token", () => {
    expect(
      parseModelListing(
        listing(
          [
            entry(`blobs/models/${sha("a")}`, 6_891_222),
            entry("blobs/models/not-a-hash", 1),
            entry(`blobs/models/${sha("b")}`, 99_328_032),
          ],
          "token-2"
        )
      )
    ).toStrictEqual({
      files: [
        { sha256: sha("a"), size: 6_891_222 },
        { sha256: sha("b"), size: 99_328_032 },
      ],
      next: "token-2",
    });
  });

  it("ends on a page that isn't truncated", () => {
    expect(
      parseModelListing(listing([entry(`blobs/models/${sha("c")}`, 3)]))
    ).toStrictEqual({
      files: [{ sha256: sha("c"), size: 3 }],
      next: undefined,
    });
  });
});

describe("the machine's model files cache", () => {
  it("keeps a file once when two fills take it at the same time", async () => {
    const { dir, file } = exported();

    const kept = await Promise.all([
      keepFromDir(dir, file),
      keepFromDir(dir, file),
    ]);

    expect({ kept, cached: await isCached(file) }).toStrictEqual({
      kept: [true, true],
      cached: true,
    });
  });

  it("doesn't take a kept file whose bytes changed for the file, and a fill puts it right", async () => {
    const { dir, file } = exported();
    await keepFromDir(dir, file);
    const bytes = readFileSync(cachedModelFile(file));
    bytes[0] = bytes[0] === 0 ? 1 : 0;
    writeFileSync(cachedModelFile(file), bytes);

    const changed = await isCached(file);
    await keepFromDir(dir, file);

    expect({ changed, mended: await isCached(file) }).toStrictEqual({
      changed: false,
      mended: true,
    });
  });
});
