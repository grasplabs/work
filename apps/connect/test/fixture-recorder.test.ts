import { credentialStandIn } from "@grasp-os/runtime/connector";
import { describe, expect, it } from "vite-plus/test";

import { recordFixtures } from "./fixture-recorder.ts";
import { sampleKeyApiHost } from "./fixtures/sample-key/connector.ts";

// Recording a connector's fixtures through connect's whole call path,
// against a vendor that echoes what it shouldn't. The threat model comes
// first; each case is a way it could fail:
//
// FX1  The credential kept: in what the vendor echoed back (an answer's
//      body or a header, a tool's output), a URL, or a request's headers,
//      as is or encoded (escaped, percent-encoded, base64 within a cursor).
// FX2  Cookies or other headers of a session kept.
// FX3  Personal data kept: under a field named personal, within a longer
//      text, an address anywhere; or replaced so differently in two places
//      that the recording no longer links what the vendor linked.
// FX4  A recording run changing something at the vendor: a tool that
//      writes, called for real.
// FX5  Personal data kept where no rule can replace it: in arguments
//      written by hand, or inside base64.
// FX6  A secret no rule knows of kept: a download's signed URL, which
//      egress follows off the connector's hosts (refused by the recorder
//      for any request off them; the sample apps have no download).

const key = `key/${crypto.randomUUID()}+`;
/** A secret of the account's other than the key: its webhooks' signing secret. */
const signing = `whsec_${crypto.randomUUID()}`;
const ada = "ada@acme.test";
const name = "Ada Lovelace";
/** An address in free text, by the grammar's letters and marks. */
const jose = "josé.o'garcía@acme.es";

/**
 * The sample key app, echoing its signing secret (its key too, with
 * `echoKey`) and naming people (its account's `owner`), its first page's
 * next where `cursor` puts it.
 */
const vendorWith =
  ({
    cursor = "page-2",
    owner = name,
    echoKey = false,
  }: { cursor?: string | null; owner?: string; echoKey?: boolean } = {}) =>
  (request: Request): Response => {
    const url = new URL(request.url);
    if (
      url.hostname !== sampleKeyApiHost ||
      request.headers.get("x-api-key") !== key
    ) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    const echoed = echoKey ? key : signing;
    const headers = {
      "set-cookie": `session=${key}`,
      "x-request-key": key,
      link: `<https://${sampleKeyApiHost}/v1/next?key=${encodeURIComponent(echoed)}&by=${encodeURIComponent(ada)}>; rel="next"`,
    };
    if (url.pathname === "/v1/whoami") {
      return Response.json(
        {
          account: { id: "team-1", name: owner, email: ada },
          ...(echoKey ? { key } : {}),
          signing_secret: signing,
        },
        { headers }
      );
    }
    if (url.pathname === "/v1/boards/board-1/items") {
      return url.searchParams.get("cursor") === null
        ? Response.json(
            {
              items: [
                {
                  id: "item-1",
                  title: `Shared by ${name} (${ada}) with ${echoed}, cc ${jose}: ${name}_CV.pdf`,
                },
              ],
              next_cursor: cursor,
            },
            { headers }
          )
        : Response.json({
            items: [
              { id: "item-2", title: JSON.stringify({ name: "Grace Hopper" }) },
            ],
            next_cursor: null,
          });
    }
    if (url.pathname === "/v1/boards/busy/items") {
      return Response.json(
        { message: "Slow down" },
        { status: 429, headers: { "retry-after": "60" } }
      );
    }
    return Response.json({ message: "No such board" }, { status: 404 });
  };

const vendor = vendorWith();

const listed = {
  tool: "boards.items.list",
  args: { board: "board-1" },
  cursor: "cursor",
  calls: [],
};

const plan = {
  personal: ["name", "email"],
  secret: ["signing_secret"],
  cases: [
    listed,
    {
      tool: "boards.items.list",
      args: { board: "gone" },
      error: "not_found" as const,
      calls: [],
    },
  ],
};

describe("recording a connector's fixtures", () => {
  it("FX1, FX2: keeps no secret, cookie or session header, wherever the vendor echoed them", async () => {
    const recorded = await recordFixtures("sample-key", key, plan, vendor);
    const text = JSON.stringify(recorded);
    expect({
      key: [key, encodeURIComponent(key), JSON.stringify(key), signing].some(
        (form) => text.includes(form)
      ),
      standIn: text.includes(credentialStandIn),
      headers: recorded.cases[0]?.calls[0]?.exchanges[0]?.answer.headers,
    }).toStrictEqual({
      key: false,
      standIn: true,
      headers: {
        "content-type": "application/json",
        link: `<https://${sampleKeyApiHost}/v1/next?key=${credentialStandIn}&by=${encodeURIComponent("person-1@example.com")}>; rel="next"`,
      },
    });
  });

  it("FX1: refuses a recording whose vendor echoed the credential, anywhere", async () => {
    await expect(
      recordFixtures("sample-key", key, plan, vendorWith({ echoKey: true }))
    ).rejects.toThrow("The account lookup carries the connection's credential");
  });

  it("FX1: refuses a recording that carries the credential inside base64", async () => {
    await expect(
      recordFixtures(
        "sample-key",
        key,
        { ...plan, cases: plan.cases.toReversed() },
        // Not on a 3-byte boundary, so the key's own base64 isn't within it.
        vendorWith({ cursor: btoa(`{"token":"${key}"}`) })
      )
    ).rejects.toThrow("Case 2 carries the connection's credential");
    // JSON within a string, escaped as PHP does (`\/`).
    await expect(
      recordFixtures(
        "sample-key",
        key,
        plan,
        vendorWith({
          cursor: JSON.stringify({ token: key }).replaceAll("/", "\\/"),
        })
      )
    ).rejects.toThrow("Case 1 carries the connection's credential");
  });

  it("FX3: replaces each personal value by one stand-in, wherever it shows", async () => {
    const recorded = await recordFixtures("sample-key", key, plan, vendor);
    const [list, gone] = recorded.cases;
    const text = JSON.stringify(recorded);
    expect({
      personal: [ada, "Lovelace", "garcía"].some((value) =>
        text.includes(value)
      ),
      account: recorded.account?.answer.body,
      outputs: list?.calls.map(({ output }) => output),
      gone: gone?.calls.map(({ exchanges, output }) => ({
        statuses: exchanges.map(({ answer }) => answer.status),
        output,
      })),
    }).toStrictEqual({
      personal: false,
      account: {
        account: {
          id: "team-1",
          name: "person-2",
          email: "person-1@example.com",
        },
        signing_secret: credentialStandIn,
      },
      outputs: [
        {
          items: [
            {
              id: "item-1",
              title: `Shared by person-2 (person-1@example.com) with ${credentialStandIn}, cc person-3@example.com: person-2_CV.pdf`,
            },
          ],
          next: "page-2",
        },
        {
          items: [
            { id: "item-2", title: JSON.stringify({ name: "person-4" }) },
          ],
          next: null,
        },
      ],
      gone: [{ statuses: [404], output: undefined }],
    });
  });

  it("FX3: replaces a short personal value only where a whole value is it", async () => {
    const recorded = await recordFixtures(
      "sample-key",
      key,
      plan,
      vendorWith({ owner: "v1" })
    );
    expect({
      account: recorded.account?.answer.body,
      url: recorded.cases[0]?.calls[0]?.exchanges[0]?.request.url,
    }).toStrictEqual({
      account: {
        account: {
          id: "team-1",
          name: "person-2",
          email: "person-1@example.com",
        },
        signing_secret: credentialStandIn,
      },
      url: `https://${sampleKeyApiHost}/v1/boards/board-1/items`,
    });
  });

  it("FX4: refuses to record a tool that writes", async () => {
    await expect(
      recordFixtures(
        "sample",
        key,
        {
          personal: [],
          cases: [
            {
              tool: "items.send",
              args: { mailbox: "m", subject: "s" },
              calls: [],
            },
          ],
        },
        vendor
      )
    ).rejects.toThrow(
      "sample's items.send isn't a tool that only reads: it isn't recorded"
    );
  });

  it("FX5: refuses personal data in a case's arguments, or inside base64", async () => {
    const byAddress = {
      tool: "boards.items.list",
      args: { board: ada },
      error: "not_found" as const,
      calls: [],
    };
    await expect(
      recordFixtures("sample-key", key, { ...plan, cases: [byAddress] }, vendor)
    ).rejects.toThrow(
      "Case 1's arguments hold personal data, which a recording doesn't keep: call it with an id instead"
    );
    await expect(
      recordFixtures(
        "sample-key",
        key,
        plan,
        // Its start isn't the base64's, so the value is off its boundary.
        vendorWith({ cursor: `v1_${btoa(JSON.stringify({ after: name }))}` })
      )
    ).rejects.toThrow(
      "The recording carries personal data where it can't be replaced"
    );
    // JSON within a string, escaped as Python does (`\u00e9`).
    await expect(
      recordFixtures(
        "sample-key",
        key,
        plan,
        vendorWith({
          cursor: '{"after":"Jos\\u00e9 Garc\\u00eda"}',
          owner: "José García",
        })
      )
    ).rejects.toThrow(
      "The recording carries personal data where it can't be replaced"
    );
  });

  it("records every case and output after a rate limit, which pauses the connection", async () => {
    const recorded = await recordFixtures(
      "sample-key",
      key,
      {
        ...plan,
        cases: [
          {
            tool: "boards.items.list",
            args: { board: "busy" },
            error: "throttled" as const,
            calls: [],
          },
          listed,
        ],
      },
      vendor
    );
    expect(
      recorded.cases.map(({ calls }) =>
        calls.map(({ exchanges, output }) => ({
          status: exchanges[0]?.answer.status,
          output: output !== undefined,
        }))
      )
    ).toStrictEqual([
      [{ status: 429, output: false }],
      [
        { status: 200, output: true },
        { status: 200, output: true },
      ],
    ]);
  });

  it("stops at a call that doesn't end as its case says", async () => {
    await expect(
      recordFixtures(
        "sample-key",
        key,
        { ...plan, cases: [{ ...listed, error: "not_found" as const }] },
        vendor
      )
    ).rejects.toThrow(
      "boards.items.list succeeded, and its case is an error case"
    );
    await expect(
      recordFixtures("sample-key", key, plan, vendorWith({ cursor: null }))
    ).rejects.toThrow(
      "boards.items.list answered one page: record it with arguments that list more than a page"
    );
  });
});
