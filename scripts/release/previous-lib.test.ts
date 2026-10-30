import { describe, expect, it } from "vite-plus/test";

import { parseReleaseListing } from "./bucket-lib.ts";
import { newestReleaseIds } from "./previous-lib.ts";

describe("the release before the one CI publishes", () => {
  it("is the newest published release by year, month and N, never a local build", () => {
    const ids = [
      "26.09.31",
      "26.10.9",
      "dev-abc123",
      "26.10.10",
      "25.12.200",
      "26.10.2",
    ];
    expect(newestReleaseIds(ids)).toStrictEqual([
      "26.10.10",
      "26.10.9",
      "26.10.2",
      "26.09.31",
      "25.12.200",
    ]);
    expect(newestReleaseIds(["dev-abc123"])).toStrictEqual([]);
  });

  it("is read from every page of the bucket's listing", () => {
    const page = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><IsTruncated>true</IsTruncated>
<CommonPrefixes><Prefix>releases/26.10.1/</Prefix></CommonPrefixes>
<CommonPrefixes><Prefix>releases/26.10.2/</Prefix></CommonPrefixes>
<NextContinuationToken>next-page</NextContinuationToken></ListBucketResult>`;
    expect(parseReleaseListing(page)).toStrictEqual({
      ids: ["26.10.1", "26.10.2"],
      next: "next-page",
    });
    expect(
      parseReleaseListing(
        "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"
      )
    ).toStrictEqual({ ids: [], next: undefined });
  });
});
