/**
 * A D1 database's restore point: its Time Travel bookmark now, which a
 * person can restore the database to (`wrangler d1 time-travel restore
 * --bookmark`, or the API's `time_travel/restore`). The admin takes one
 * before it migrates a client's database (src/hosting/operation.ts,
 * `snapshot`) and never restores one itself: a migration is expand only,
 * so the release before runs on the new schema, and only a person can
 * tell whether data needs to go back.
 *
 * The call, as Cloudflare documents it (API reference, D1, "Get D1
 * database bookmark", read 28 November 2026): `GET
 * /accounts/{account_id}/d1/database/{database_id}/time_travel/bookmark`,
 * with no `timestamp` for the current bookmark, answering `{ bookmark }`,
 * which the reference marks optional. Any of D1 Read, D1 Write or D1
 * Metadata Read lets the token make it; the deployer's has D1 Write.
 */
import "@tanstack/react-start/server-only";
import { z } from "zod";

import type { CloudflareApi } from "./api.ts";

const bookmarkSchema = z.object({ bookmark: z.string().min(1).optional() });

/**
 * Database `databaseId`'s current Time Travel bookmark in account
 * `accountId`; undefined when Cloudflare answers none.
 */
export const d1Bookmark = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string
): Promise<string | undefined> => {
  const { bookmark } = await api.call(
    {
      method: "GET",
      path: `/accounts/${accountId}/d1/database/${databaseId}/time_travel/bookmark`,
    },
    bookmarkSchema
  );
  return bookmark;
};
