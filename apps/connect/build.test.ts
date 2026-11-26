import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { recordedFixtures } from "@grasp-os/runtime/connector";
import type {
  Captured,
  Exchange,
  FixtureCall,
  Fixtures,
} from "@grasp-os/runtime/connector";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { buildConnectors } from "./build.ts";

// Connect's build holds a connector to its recorded vendor answers
// (fixtures.json beside its entry): each case replayed on workerd, in the
// bundle connect ships, with the recordings as its only network.

const scratch = path.join(import.meta.dirname, "dist/test");
const folders: string[] = [];

/** A connector of one API's items: a list that pages, an item, and a check it reads twice. */
const connector = `import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

const Item = v.object({ id: v.string() });

export default defineConnector({
  name: "replayed",
  title: "Replayed",
  hosts: ["api.replayed.test"],
  base: "/v1",
  auth: auth.apiKey({
    header: "x-api-key",
    account: { url: "https://api.replayed.test/v1/me", id: "/id" },
  }),
  tools: {
    "items.list": tool({
      description: "Lists the items",
      readOnly: true,
      reach: "company",
      routes: ["GET /items"],
      args: { cursor: v.string().optional() },
      returns: page(Item),
      handler: async ({ cursor }, api) => {
        const answer = await api.get("/items", {
          query: { cursor },
          returns: v.object({ items: v.array(Item), next: v.string().nullable() }),
        });
        return { items: answer.items, next: answer.next };
      },
    }),
    "items.get": tool({
      description: "Gets an item",
      readOnly: true,
      reach: "company",
      routes: ["GET /items/{id}"],
      args: { id: v.string() },
      returns: Item,
      handler: async ({ id }, api) =>
        await api.get("/items/{id}", { path: { id }, returns: Item }),
    }),
    "checks.get": tool({
      description: "Gets a check twice, to be sure",
      readOnly: true,
      reach: "company",
      routes: ["GET /checks/{id}"],
      args: { id: v.string() },
      returns: Item,
      handler: async ({ id }, api) => {
        await api.get("/checks/{id}", { path: { id } });
        return await api.get("/checks/{id}", { path: { id }, returns: Item });
      },
    }),
  },
});
`;

const api = "https://api.replayed.test/v1";

const exchange = (
  url: string,
  status: number,
  body: Exchange["answer"]["body"]
): Exchange => ({
  request: { method: "GET", url: `${api}${url}` },
  answer: { status, headers: { "content-type": "application/json" }, body },
});

/** Two pages of items, the second the last. */
const pages: FixtureCall[] = [
  {
    exchanges: [
      exchange("/items", 200, { items: [{ id: "1" }], next: "page-2" }),
    ],
    output: { items: [{ id: "1" }], next: "page-2" },
  },
  {
    exchanges: [
      exchange("/items?cursor=page-2", 200, {
        items: [{ id: "2" }],
        next: null,
      }),
    ],
    output: { items: [{ id: "2" }], next: null },
  },
];

const missing = exchange("/items/9", 404, { message: "No such item" });

/** Fixtures a connector that keeps to its vendor replays, and `cases`. */
const recorded = (cases: Fixtures["cases"] = []): Fixtures => ({
  personal: [],
  cases: [
    { tool: "items.list", args: {}, cursor: "cursor", calls: pages },
    {
      tool: "items.get",
      args: { id: "9" },
      error: "not_found",
      calls: [{ exchanges: [missing] }],
    },
    ...cases,
  ],
});

/** Builds the connector with `fixtures` beside it. */
const buildWith = async (fixtures: Fixtures): Promise<void> => {
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(path.join(scratch, "replayed-"));
  folders.push(folder);
  writeFileSync(path.join(folder, "connector.ts"), connector);
  writeFileSync(path.join(folder, "fixtures.json"), JSON.stringify(fixtures));
  await buildConnectors(
    [path.join(folder, "connector.ts")],
    path.join(folder, "connectors.js")
  );
};

const refusal = "replayed doesn't replay its recorded vendor answers:\n";

describe(
  "connect's build, replaying a connector's recorded vendor answers",
  { timeout: 60_000 },
  () => {
    afterAll(() => {
      for (const folder of folders) {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it("builds a connector whose every case replays as recorded", async () => {
      await expect(buildWith(recorded())).resolves.toBeUndefined();
    });

    it("replays what a recording keeps, its personal values replaced", async () => {
      const ada = "ada@acme.test";
      const captured = (url: string, answer: unknown): Captured => ({
        method: "GET",
        url: `${api}${url}`,
        body: "",
        status: 200,
        headers: { "content-type": "application/json" },
        answer: JSON.stringify(answer),
      });
      const { fixtures: kept } = recordedFixtures(
        {
          cases: [
            {
              tool: "items.list",
              args: {},
              cursor: "cursor",
              calls: [
                {
                  exchanges: [
                    captured("/items", {
                      items: [{ id: ada }],
                      next: `after-${ada}`,
                    }),
                  ],
                },
                {
                  exchanges: [
                    captured(
                      `/items?cursor=${encodeURIComponent(`after-${ada}`)}`,
                      { items: [{ id: "2" }], next: null }
                    ),
                  ],
                },
              ],
            },
          ],
        },
        { credential: "test-key-0123456789", personal: [], secret: [] }
      );
      // The outputs a recording run makes of what is kept, as the tool
      // answers from it.
      // `after-ada@acme.test` is an address of its own, by the grammar.
      const outputs = [
        {
          items: [{ id: "person-1@example.com" }],
          next: "person-2@example.com",
        },
        { items: [{ id: "2" }], next: null },
      ];
      const recording: Fixtures = {
        ...kept,
        cases: kept.cases.map((each) => ({
          ...each,
          calls: each.calls.map((call, index) => ({
            ...call,
            output: outputs[index],
          })),
        })),
      };
      expect(JSON.stringify(recording)).not.toContain(ada);
      await expect(buildWith(recording)).resolves.toBeUndefined();
    });

    it("refuses output that doesn't match its recordings", async () => {
      // The vendor answered a number where the connector says a string.
      const numbered = exchange("/items/7", 200, { id: 7 });
      await expect(
        buildWith(
          recorded([
            {
              tool: "items.get",
              args: { id: "7" },
              calls: [{ exchanges: [numbered], output: { id: "7" } }],
            },
          ])
        )
      ).rejects.toThrow(
        `${refusal}items.get (case 3): output doesn't match its recordings`
      );
      // The call answers, but not what it was recorded answering.
      const seven = exchange("/items/7", 200, { id: "7" });
      await expect(
        buildWith(
          recorded([
            {
              tool: "items.get",
              args: { id: "7" },
              calls: [{ exchanges: [seven], output: { id: "8" } }],
            },
          ])
        )
      ).rejects.toThrow(
        `${refusal}items.get (case 3): output doesn't match its recordings: it answered {"id":"7"} on call 1`
      );
    });

    it("refuses a connector that sends a request its recording doesn't have, or sends one again", async () => {
      const elsewhere = exchange("/items/7?expand=all", 200, { id: "7" });
      await expect(
        buildWith(
          recorded([
            {
              tool: "items.get",
              args: { id: "7" },
              calls: [{ exchanges: [elsewhere], output: { id: "7" } }],
            },
          ])
        )
      ).rejects.toThrow(
        /items\.get \(case 3\): output doesn't match its recordings: it sent GET https:\/\/api\.replayed\.test\/v1\/items\/7, which isn't recorded/u
      );
      const once = exchange("/checks/7", 200, { id: "7" });
      await expect(
        buildWith(
          recorded([
            {
              tool: "checks.get",
              args: { id: "7" },
              calls: [{ exchanges: [once], output: { id: "7" } }],
            },
          ])
        )
      ).rejects.toThrow(
        `${refusal}checks.get (case 3): output doesn't match its recordings: it sent GET ${api}/checks/7 again`
      );
    });

    it("refuses paging that never ends, or a list recorded on one page", async () => {
      // Its next comes back: the vendor pages in a circle.
      const again: FixtureCall = {
        exchanges: [
          exchange("/items?cursor=page-2", 200, {
            items: [{ id: "2" }],
            next: "page-2",
          }),
        ],
        output: { items: [{ id: "2" }], next: "page-2" },
      };
      const [first = again] = pages;
      await expect(
        buildWith(
          recorded([
            {
              tool: "items.list",
              args: {},
              cursor: "cursor",
              calls: [first, again, again],
            },
          ])
        )
      ).rejects.toThrow(
        `items.list (case 3): paging never ends: its next "page-2" comes back`
      );
      // Past the vendor's last recorded page it still answers a next.
      const endless: FixtureCall = {
        exchanges: [
          exchange("/items?cursor=page-2", 200, {
            items: [{ id: "2" }],
            next: "page-3",
          }),
        ],
        output: { items: [{ id: "2" }], next: "page-3" },
      };
      await expect(
        buildWith(
          recorded([
            {
              tool: "items.list",
              args: {},
              cursor: "cursor",
              calls: [first, endless],
            },
          ])
        )
      ).rejects.toThrow(
        `items.list (case 3): paging never ends: after the vendor's last recorded page it answers next "page-3"`
      );
      // One page proves nothing of the cursor: a list that drops it passes.
      await expect(
        buildWith(
          recorded([
            { tool: "items.list", args: {}, cursor: "cursor", calls: [first] },
          ])
        )
      ).rejects.toThrow(
        `items.list (case 3): only one page is recorded: record it with arguments that list more than a page`
      );
    });

    it("refuses an error mapped to the wrong kind", async () => {
      // The vendor's 403 is its rate limit, as its docs say and the
      // recording keeps: the connector declares nothing that says so.
      const limited = exchange("/items/8", 403, {
        error: { code: "rateLimitExceeded" },
      });
      await expect(
        buildWith(
          recorded([
            {
              tool: "items.get",
              args: { id: "8" },
              error: "throttled",
              calls: [{ exchanges: [limited] }],
            },
          ])
        )
      ).rejects.toThrow(
        "items.get (case 3): errors map to the wrong kind: the vendor's 403 is recorded as throttled, and the call failed as access_denied"
      );
      // An error case the vendor answered: the call succeeding is wrong too.
      const found = exchange("/items/8", 200, { id: "8" });
      await expect(
        buildWith(
          recorded([
            {
              tool: "items.get",
              args: { id: "8" },
              error: "not_found",
              calls: [{ exchanges: [found] }],
            },
          ])
        )
      ).rejects.toThrow(
        "items.get (case 3): errors map to the wrong kind: the vendor's 200 is recorded as not_found, and the call succeeded"
      );
    });
  }
);
