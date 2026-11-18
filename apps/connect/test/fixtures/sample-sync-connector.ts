/**
 * A connector that syncs, which connect's sync tests read through
 * (test/sync.test.ts), built into the test bundle with the others
 * (test/global-setup.ts). Its `files` sync reads the sample provider's
 * change feed of the connection's own account and passes it on as neutral
 * items, as a real connector's sync does. It is naive on purpose: it
 * passes the provider's next position on as the cursor unchecked, and asks
 * for whatever path the cursor `probe-<path>` names, so the tests show
 * what connect refuses of a connector's sync.
 */
import { ToolError, defineConnector } from "@grasp-os/connector-kit/connector";
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import { RestartSyncError, defineSync } from "@grasp-os/connector-kit/sync";
import { syncItemSchema } from "@grasp-os/shared/sync";
import { z } from "zod";

import { sampleHost } from "./sample-connector.ts";

const api = `https://${sampleHost}`;

/** The sample provider's change feed, as it answers it. */
const feedSchema = z.object({
  changes: z.array(syncItemSchema),
  next: z.string(),
  more: z.boolean(),
});

const probePrefix = "probe-";

export default defineConnector({
  name: "sample-sync",
  version: "1.0.0",
  provider: "microsoft",
  scopes: ["Files.Read"],
  hosts: [sampleHost],
  tools: [],
  syncs: [
    defineSync({
      name: "files",
      kind: "file",
      routes: [{ method: "GET", host: sampleHost, path: "/v1/me/changes" }],
      read: async ({ cursor }) => {
        const url =
          cursor !== null && cursor.startsWith(probePrefix)
            ? new URL(`${api}/v1/${cursor.slice(probePrefix.length)}`)
            : new URL(`${api}/v1/me/changes`);
        if (cursor !== null) {
          url.searchParams.set("from", cursor);
        }
        const response = await fetch(url);
        if (response.status === 410) {
          throw new RestartSyncError();
        }
        if (response.status === 429) {
          throw new ToolError("The provider is throttling reads", {
            code: "throttled",
            retryAfterSeconds: Number(response.headers.get("retry-after")),
          });
        }
        if (response.status === 401 && !response.headers.has(egressHeader)) {
          throw new ToolError("The provider refused access", {
            code: "access_denied",
          });
        }
        if (!response.ok) {
          throw new Error(`The provider answered ${response.status}`);
        }
        const feed = feedSchema.parse(await response.json());
        return { items: feed.changes, cursor: feed.next, more: feed.more };
      },
    }),
    // Places of the account it lists itself (a mailbox's folders), each
    // read from its own feed, the route's `{place}` bound to it.
    defineSync({
      name: "folders",
      kind: "mail",
      routes: [
        { method: "GET", host: sampleHost, path: "/v1/me/folders" },
        {
          method: "GET",
          host: sampleHost,
          path: "/v1/me/folders/{place}/changes",
        },
        // A names-only listing, and items fetched by ID (core's daily pass).
        {
          method: "GET",
          host: sampleHost,
          path: "/v1/me/folders/{place}/names",
        },
        {
          method: "GET",
          host: sampleHost,
          path: "/v1/me/folders/{place}/items",
        },
      ],
      places: async ({ cursor }) => {
        const url = new URL(`${api}/v1/me/folders`);
        if (cursor !== null) {
          url.searchParams.set("from", cursor);
        }
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`The provider answered ${response.status}`);
        }
        const { folders, next } = z
          .object({ folders: z.array(z.string()), next: z.string().nullish() })
          .parse(await response.json());
        return { places: folders, cursor: next ?? null };
      },
      read: async ({ place, cursor, names, ids }) => {
        const folder = `${api}/v1/me/folders/${encodeURIComponent(place)}`;
        let url: URL;
        if (ids === null) {
          url = new URL(`${folder}/${names ? "names" : "changes"}`);
          if (cursor !== null) {
            url.searchParams.set("from", cursor);
          }
        } else {
          url = new URL(`${folder}/items`);
          for (const id of ids) {
            url.searchParams.append("id", id);
          }
        }
        const response = await fetch(url);
        if (response.status === 410) {
          throw new RestartSyncError();
        }
        if (!response.ok) {
          throw new Error(`The provider answered ${response.status}`);
        }
        const feed = feedSchema.parse(await response.json());
        return { items: feed.changes, cursor: feed.next, more: feed.more };
      },
    }),
  ],
});
