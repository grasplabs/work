import { describe, expect, it } from "vite-plus/test";

import {
  fixtureVendor,
  recordedFixtures,
} from "../../src/connector/connector.ts";

const credential = "test-key-0123456789";

/** What is kept of a recording whose one answer names Ada Lovelace. */
const { fixtures, refuseKnownIn } = recordedFixtures(
  {
    cases: [
      {
        tool: "people.list",
        args: {},
        calls: [
          {
            exchanges: [
              {
                method: "GET",
                url: "https://api.example.test/people",
                body: "",
                status: 200,
                headers: { "content-type": "application/json" },
                answer: JSON.stringify({
                  people: [{ name: "Ada Lovelace", note: "Ada&#32;Lovelace" }],
                }),
              },
            ],
          },
        ],
      },
    ],
  },
  { credential, personal: ["name"], secret: [] }
);

describe("the outputs a recording run makes", () => {
  it("keeps an output of stand-ins and addresses the tool built", () => {
    expect(
      fixtures.cases[0]?.calls[0]?.exchanges[0]?.answer.body
    ).toStrictEqual({
      people: [{ name: "person-1", note: "Ada&#32;Lovelace" }],
    });
    expect(() => {
      refuseKnownIn([{ name: "PERSON-1", email: "person-1@acme.test" }]);
    }).not.toThrow();
  });

  it("refuses an output that decodes a personal value or the credential", () => {
    expect(() => {
      refuseKnownIn([{ name: "ada lovelace" }]);
    }).toThrow("The recording carries personal data");
    expect(() => {
      refuseKnownIn([{ token: btoa(credential) }]);
    }).toThrow("The recording still carries the credential");
  });
});

describe("a recording that carries the credential", () => {
  it("is refused when base64 carries it at the end of a part-filled group", () => {
    // 20 bytes: the last group holds two, unpadded.
    const answer = JSON.stringify({
      token: btoa(`x${credential}`).replace(/=+$/u, ""),
    });
    expect(() =>
      recordedFixtures(
        {
          cases: [
            {
              tool: "people.list",
              args: {},
              calls: [
                {
                  exchanges: [
                    {
                      method: "GET",
                      url: "https://api.example.test/people",
                      body: "",
                      status: 200,
                      headers: { "content-type": "application/json" },
                      answer,
                    },
                  ],
                },
              ],
            },
          ],
        },
        { credential, personal: [], secret: [] }
      )
    ).toThrow("Case 1 carries the connection's credential");
  });
});

describe("the vendor a recording makes", () => {
  it("answers only a query whose every name and value is as recorded", async () => {
    const vendor = fixtureVendor([
      {
        request: {
          method: "GET",
          url: "https://api.example.test/items?filter=status%3Dopen&limit=2",
        },
        answer: { status: 200, headers: {}, body: { items: [] } },
      },
    ]);
    const answered = async (query: string): Promise<boolean> =>
      (await vendor.answer(
        new Request(`https://api.example.test/items?${query}`)
      )) !== undefined;
    expect({
      reordered: await answered("limit=2&filter=status%3Dopen"),
      moved: await answered("filter%3Dstatus=open&limit=2"),
    }).toStrictEqual({ reordered: true, moved: false });
  });
});
