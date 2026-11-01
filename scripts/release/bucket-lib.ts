/**
 * A releases bucket, through R2's S3 API, as the release scripts reach it:
 * its keys' URLs, signed requests, and the ids of the releases under
 * `releases/`.
 *
 * Env: R2_ENDPOINT (https://<account id>.eu.r2.cloudflarestorage.com),
 *      R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */
import { AwsClient } from "aws4fetch";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

const prefixPattern = /<Prefix>releases\/(?<id>[^/<]+)\/<\/Prefix>/gu;
const truncatedPattern = /<IsTruncated>true<\/IsTruncated>/u;
const tokenPattern =
  /<NextContinuationToken>(?<token>[^<]+)<\/NextContinuationToken>/u;

/** One page of an S3 ListObjectsV2 of `releases/` by `/`: the ids, and the next page's token. */
export const parseReleaseListing = (
  xml: string
): { ids: string[]; next: string | undefined } => ({
  ids: [...xml.matchAll(prefixPattern)].flatMap(({ groups }) =>
    groups?.id === undefined ? [] : [groups.id]
  ),
  next: truncatedPattern.test(xml)
    ? tokenPattern.exec(xml)?.groups?.token
    : undefined,
});

export interface ReleasesBucket {
  /** A key's URL in the bucket. */
  url: (key: string) => string;
  /** A request signed for the bucket. */
  fetch: AwsClient["fetch"];
  /**
   * The id of every release with anything under `releases/<id>/` whose id
   * starts with `idPrefix`: a published release's, or one whose upload
   * stopped before its manifest.
   */
  listIds: (idPrefix?: string) => Promise<string[]>;
}

/** The bucket the environment names. */
export const releasesBucketFromEnv = (): ReleasesBucket => {
  const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/u, "");
  const bucket = requireEnv("R2_BUCKET");
  const client = new AwsClient({
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });
  const listIds = async (idPrefix = ""): Promise<string[]> => {
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const query = new URLSearchParams({
        "list-type": "2",
        prefix: `releases/${idPrefix}`,
        delimiter: "/",
        ...(token === undefined ? {} : { "continuation-token": token }),
      });
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const response = await client.fetch(
        `${endpoint}/${bucket}?${query.toString()}`
      );
      if (!response.ok) {
        throw new Error(`LIST releases/${idPrefix}: ${response.status}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const page = parseReleaseListing(await response.text());
      ids.push(...page.ids);
      token = page.next;
    } while (token !== undefined);
    return ids;
  };
  return {
    url: (key) => `${endpoint}/${bucket}/${key}`,
    fetch: async (...request) => await client.fetch(...request),
    listIds,
  };
};
