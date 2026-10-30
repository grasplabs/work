/**
 * A destination's account and the resources a deployment needs in it. Everything
 * that stores data is created in the EU jurisdiction and nowhere else
 * (threat model R18); one that already exists outside it stops the caller,
 * since a jurisdiction is set only at creation.
 *
 * The `ensure*` calls are idempotent, so a provisioning step can run again
 * after a failure: each finds the resource first and creates it only when
 * it's missing.
 */
import { z } from "zod";

import { CloudflareApiError, isNotFound, listAll } from "./api.ts";
import type { CloudflareApi } from "./api.ts";

const eu = "eu";

const accountSchema = z.object({ id: z.string(), name: z.string() });
export type Account = z.infer<typeof accountSchema>;

/** The account `accountId`, as the token sees it. */
export const getAccount = async (
  api: CloudflareApi,
  accountId: string
): Promise<Account> =>
  await api.call(
    { method: "GET", path: `/accounts/${accountId}` },
    accountSchema
  );

/** A resource Grasp needs in the EU that exists elsewhere. */
export class OutsideEuError extends Error {
  constructor(kind: string, name: string, jurisdiction: string | undefined) {
    super(
      `${kind} ${name} exists outside the EU jurisdiction (${jurisdiction ?? "none"}); it has to be recreated`
    );
    this.name = "OutsideEuError";
  }
}

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

/** The D1 database `name` in the EU, created if it's missing. */
export const ensureD1Database = async (
  api: CloudflareApi,
  accountId: string,
  name: string
): Promise<D1DatabaseInfo> => {
  const database =
    (await findD1Database(api, accountId, name)) ??
    (await createD1Database(api, accountId, name, eu));
  // Whichever call answered, only a database Cloudflare reports in the EU
  // is used.
  if (database.jurisdiction !== eu) {
    throw new OutsideEuError(
      "D1 database",
      name,
      database.jurisdiction ?? undefined
    );
  }
  return database;
};

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

/** The R2 bucket `name` in the EU, created if it's missing. */
export const ensureR2Bucket = async (
  api: CloudflareApi,
  accountId: string,
  name: string
): Promise<R2BucketInfo> => {
  const bucket =
    (await findR2Bucket(api, accountId, name, eu)) ??
    (await createR2Bucket(api, accountId, name, eu));
  // Whichever call answered, only a bucket Cloudflare reports in the EU is
  // used.
  if (bucket.jurisdiction !== eu) {
    throw new OutsideEuError(
      "R2 bucket",
      name,
      bucket.jurisdiction ?? undefined
    );
  }
  return bucket;
};

/**
 * An AI Gateway, with every setting it reports kept: an update (PUT)
 * replaces them all, so turning authentication on must send the rest back
 * whole, BYOK's `store_id` and log settings included.
 */
const gatewaySchema = z.looseObject({
  id: z.string(),
  authentication: z.boolean().nullish(),
});
export type AiGatewayInfo = z.infer<typeof gatewaySchema>;

/** What a gateway reports but an update doesn't take: ids and timestamps. */
const readOnlyGatewayFields: ReadonlySet<string> = new Set([
  "id",
  "created_at",
  "modified_at",
  "is_default",
  "account_id",
  "account_tag",
  "internal_id",
]);

/** The AI Gateway `id` at `path`, or undefined when there's none. */
const gatewayNamed = async (
  api: CloudflareApi,
  path: string,
  id: string
): Promise<AiGatewayInfo | undefined> => {
  try {
    return await api.call(
      { method: "GET", path: `${path}/${id}` },
      gatewaySchema
    );
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * The AI Gateway `id`, created if it's missing, and always authenticated:
 * the gateway holds the client's provider keys (BYOK), so without
 * authentication anyone who knows its URL could spend them (threat model
 * CO14). Core reaches it through the AI binding, which Cloudflare
 * authenticates in-account, so it needs no token. An existing gateway with
 * authentication off gets it switched on, its other settings kept.
 *
 * A new gateway has no cache and no rate limit (core's model gateway
 * enforces budgets). It logs each call's metadata, which core's audit
 * events point to by log id; core turns payload logging off on every call,
 * so prompts and replies aren't kept (threat model EU7).
 */
export const ensureAiGateway = async (
  api: CloudflareApi,
  accountId: string,
  id: string
): Promise<AiGatewayInfo> => {
  const path = `/accounts/${accountId}/ai-gateway/gateways`;
  let existing = await gatewayNamed(api, path, id);
  if (existing === undefined) {
    try {
      return await api.call(
        {
          method: "POST",
          path,
          json: {
            id,
            authentication: true,
            cache_ttl: 0,
            cache_invalidate_on_update: false,
            collect_logs: true,
            rate_limiting_interval: 0,
            rate_limiting_limit: 0,
            rate_limiting_technique: "fixed",
          },
        },
        gatewaySchema
      );
    } catch (error) {
      // Another run made it between the read and the create, as two
      // clients first provisioned into one shared account at once do: the
      // create is refused, and the one it made is taken as found below,
      // its settings put right. Any other refusal stands, and a create
      // with no answer at all isn't a refusal: it isn't read again here.
      const made =
        error instanceof CloudflareApiError &&
        error.status >= 400 &&
        error.status < 500
          ? await gatewayNamed(api, path, id)
          : undefined;
      if (made === undefined) {
        throw error;
      }
      existing = made;
    }
  }
  if (existing.authentication === true) {
    return existing;
  }
  const settings = Object.fromEntries(
    Object.entries(existing).filter(
      ([field]) => !readOnlyGatewayFields.has(field)
    )
  );
  return await api.call(
    {
      method: "PUT",
      path: `${path}/${existing.id}`,
      json: { ...settings, authentication: true },
    },
    gatewaySchema
  );
};

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
