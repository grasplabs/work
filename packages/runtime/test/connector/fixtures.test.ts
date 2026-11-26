import { describe, expect, it } from "vite-plus/test";

import { recordedFixtures } from "../../src/connector/connector.ts";

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
