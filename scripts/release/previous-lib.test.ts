import { describe, expect, it } from "vite-plus/test";

import { parseReleaseListing, previousReleaseId } from "./previous-lib.ts";

describe("the release before a CI run's", () => {
  it("is the newest CI release from an earlier run, never this run's or a later one's", () => {
    const ids = [
      "r000099-aaaaaaa",
      "r000120-bbbbbbb",
      "r000121-ccccccc",
      "r000130-ddddddd",
      "dev-abc123",
    ];
    expect(previousReleaseId(ids, 121)).toBe("r000120-bbbbbbb");
    expect(previousReleaseId(ids, 99)).toBeUndefined();
  });

  it("is read from every page of the bucket's listing", () => {
    const page = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><IsTruncated>true</IsTruncated>
<CommonPrefixes><Prefix>releases/r000120-bbbbbbb/</Prefix></CommonPrefixes>
<CommonPrefixes><Prefix>releases/r000121-ccccccc/</Prefix></CommonPrefixes>
<NextContinuationToken>next-page</NextContinuationToken></ListBucketResult>`;
    expect(parseReleaseListing(page)).toStrictEqual({
      ids: ["r000120-bbbbbbb", "r000121-ccccccc"],
      next: "next-page",
    });
    expect(
      parseReleaseListing(
        "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"
      )
    ).toStrictEqual({ ids: [], next: undefined });
  });
});
