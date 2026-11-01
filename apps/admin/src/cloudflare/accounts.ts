/**
 * The D1 databases and R2 buckets a client's deployment needs in a
 * destination's account: finding, creating and deleting them.
 */
import { z } from "zod";

import { CloudflareApiError, isNotFound, listAll } from "./api.ts";
import type { CloudflareApi } from "./api.ts";

const d1Schema = z.object({
  uuid: z.string(),
  name: z.string(),
  jurisdiction: z.string().nullish(),
});
export type D1DatabaseInfo = z.infer<typeof d1Schema>;

/** The D1 database named exactly `name`, or undefined. */
export const findD1Database = async (
  api: CloudflareApi,
  accountId: string,
  name: string
): Promise<D1DatabaseInfo | undefined> => {
  // The API matches `name` as a substring: pick the exact one.
  const matches = await listAll(
    api,
    `/accounts/${accountId}/d1/database`,
    d1Schema,
    { name }
  );
  return matches.find((found) => found.name === name);
};

/**
 * Creates the D1 database `name` in `jurisdiction`, or in none when it is
 * `default` (R2's name for no jurisdiction). A POST, so it isn't retried
 * after a lost answer: the caller finds what it made by its name.
 */
export const createD1Database = async (
  api: CloudflareApi,
  accountId: string,
  name: string,
  jurisdiction: string
): Promise<D1DatabaseInfo> =>
  await api.call(
    {
      method: "POST",
      path: `/accounts/${accountId}/d1/database`,
      json: jurisdiction === "default" ? { name } : { name, jurisdiction },
    },
    d1Schema
  );

const bucketSchema = z.object({
  name: z.string(),
  jurisdiction: z.string().nullish(),
});
export type R2BucketInfo = z.infer<typeof bucketSchema>;

/**
 * The R2 bucket `name` in `jurisdiction`, or undefined. A bucket's name is
 * unique per jurisdiction, so one of the same name elsewhere is another
 * bucket, and isn't found.
 */
export const findR2Bucket = async (
  api: CloudflareApi,
  accountId: string,
  name: string,
  jurisdiction: string
): Promise<R2BucketInfo | undefined> => {
  try {
    return await api.call(
      {
        method: "GET",
        path: `/accounts/${accountId}/r2/buckets/${name}`,
        headers: { "cf-r2-jurisdiction": jurisdiction },
      },
      bucketSchema
    );
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
};

/** Creates the R2 bucket `name` in `jurisdiction`. */
export const createR2Bucket = async (
  api: CloudflareApi,
  accountId: string,
  name: string,
  jurisdiction: string
): Promise<R2BucketInfo> =>
  await api.call(
    {
      method: "POST",
      path: `/accounts/${accountId}/r2/buckets`,
      headers: { "cf-r2-jurisdiction": jurisdiction },
      json: { name },
    },
    bucketSchema
  );

/**
 * Deletes the D1 database `uuid`. One that's gone already counts as
 * deleted, so a deletion run again goes on.
 */
export const deleteD1Database = async (
  api: CloudflareApi,
  accountId: string,
  uuid: string
): Promise<void> => {
  try {
    await api.call(
      { method: "DELETE", path: `/accounts/${accountId}/d1/database/${uuid}` },
      z.unknown()
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
};

/** R2's code for a bucket that isn't empty, which it won't delete. */
const bucketNotEmpty = 10_008;

/**
 * Deletes the R2 bucket `name` in `jurisdiction`: `deleted` (or gone
 * already), or `not_empty` while it holds objects, which R2 won't delete
 * a bucket with.
 */
export const deleteR2Bucket = async (
  api: CloudflareApi,
  accountId: string,
  name: string,
  jurisdiction: string
): Promise<"deleted" | "not_empty"> => {
  try {
    await api.call(
      {
        method: "DELETE",
        path: `/accounts/${accountId}/r2/buckets/${name}`,
        headers: { "cf-r2-jurisdiction": jurisdiction },
      },
      z.unknown()
    );
    return "deleted";
  } catch (error) {
    if (isNotFound(error)) {
      return "deleted";
    }
    if (
      error instanceof CloudflareApiError &&
      error.codes.includes(bucketNotEmpty)
    ) {
      return "not_empty";
    }
    throw error;
  }
};

/**
 * Sets the R2 bucket `name`'s one lifecycle rule to delete every object a
 * day old, and abort unfinished uploads a day on: how a bucket is emptied
 * for deletion, as the API has no call that deletes its objects.
 */
export const expireAllObjects = async (
  api: CloudflareApi,
  accountId: string,
  name: string,
  jurisdiction: string
): Promise<void> => {
  await api.call(
    {
      method: "PUT",
      path: `/accounts/${accountId}/r2/buckets/${name}/lifecycle`,
      headers: { "cf-r2-jurisdiction": jurisdiction },
      json: {
        rules: [
          {
            id: "grasp-offboarding",
            enabled: true,
            conditions: { prefix: "" },
            deleteObjectsTransition: {
              condition: { type: "Age", maxAge: 86_400 },
            },
            abortMultipartUploadsTransition: {
              condition: { type: "Age", maxAge: 86_400 },
            },
          },
        ],
      },
    },
    z.unknown()
  );
};
