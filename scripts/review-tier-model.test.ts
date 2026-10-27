/* oxlint-disable require-await -- the fake API answers right away */
/**
 * The model's judgment of a pull request (review-tier-model.ts). Ways it
 * can fail, first: a diff that talks the model into a lower label, a split
 * vote read the cheap way, a refused or malformed answer taken as a
 * verdict, and patches too big to send. The Anthropic API is the only
 * thing faked.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  classify,
  combine,
  decide,
  parsePatchedFiles,
  promptFor,
} from "./review-tier-model.ts";
import type { Verdict } from "./review-tier-model.ts";

const verdict = (
  complexity: Verdict["complexity"],
  security: boolean
): Verdict => ({
  complexity,
  complexity_reason: "because",
  security,
  security_reason: "because",
});

/** The Messages API, answering each call with the next reply in turn. */
const api = (replies: readonly unknown[]) => {
  const requests: unknown[] = [];
  const queue = [...replies];
  const send = async (
    _url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    requests.push(init?.body);
    const reply = queue.shift();
    if (reply === undefined) {
      throw new Error("No more replies");
    }
    if (reply instanceof Response) {
      return reply;
    }
    const answer = Response.json({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(reply) }],
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 0,
      },
    });
    return answer;
  };
  return { send, requests };
};

const file = {
  filename: "apps/core/src/brain/read.ts",
  additions: 5,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-a\n+b",
};

describe("combining the floor and the model", () => {
  it("never lowers what the floor gave, whatever the model says", () => {
    expect(
      combine(
        { complexity: "High", security: true },
        { complexity: "Low", security: false }
      )
    ).toStrictEqual({ complexity: "High", security: true });
  });

  it("raises the floor where the model sees more", () => {
    expect(
      combine(
        { complexity: "Low", security: false },
        { complexity: "High", security: true }
      )
    ).toStrictEqual({ complexity: "High", security: true });
  });
});

describe("deciding from the votes", () => {
  it("takes the complexity most votes give", () => {
    expect(
      decide([
        verdict("Medium", false),
        verdict("Medium", false),
        verdict("High", false),
      ]).complexity
    ).toBe("Medium");
  });

  it("takes the higher complexity on a tie", () => {
    expect(
      decide([
        verdict("Low", false),
        verdict("Medium", false),
        verdict("High", false),
      ]).complexity
    ).toBe("High");
  });

  it("calls it Security when most votes do, and not on one", () => {
    expect(
      decide([
        verdict("Low", true),
        verdict("Low", true),
        verdict("Low", false),
      ]).security
    ).toBeTruthy();
    expect(
      decide([
        verdict("Low", true),
        verdict("Low", false),
        verdict("Low", false),
      ]).security
    ).toBeFalsy();
  });

  it("refuses to decide without votes", () => {
    expect(() => decide([])).toThrow("No votes");
  });
});

describe("what the model reads", () => {
  it("lists a generated file without sending its patch", () => {
    const prompt = promptFor([
      file,
      {
        filename: "pnpm-lock.yaml",
        additions: 900,
        deletions: 0,
        patch: "lockfile-body",
      },
    ]);
    expect(prompt).toContain("pnpm-lock.yaml +900 -0 (generated)");
    expect(prompt).not.toContain("lockfile-body");
  });

  it("puts code before tests, so a cut drops tests first", () => {
    const prompt = promptFor([
      {
        filename: "apps/core/test/read.test.ts",
        additions: 1,
        deletions: 0,
        patch: "test-body",
      },
      file,
    ]);
    expect(prompt.indexOf("+b")).toBeLessThan(prompt.indexOf("test-body"));
  });

  it("cuts a huge PR to its budget and says how much was left out", () => {
    const big = Array.from({ length: 40 }, (_, index) => ({
      filename: `apps/core/src/big-${index}.ts`,
      additions: 500,
      deletions: 0,
      patch: "x".repeat(20_000),
    }));
    const prompt = promptFor(big);
    expect(prompt.length).toBeLessThan(160_000);
    expect(prompt).toContain("more characters of this file cut");
    expect(prompt).toMatch(/\[\d+ more files not shown\]/u);
  });

  it("names both paths of a renamed file", () => {
    expect(
      promptFor([{ ...file, previous_filename: "apps/core/src/auth/read.ts" }])
    ).toContain(
      "apps/core/src/brain/read.ts (renamed from apps/core/src/auth/read.ts)"
    );
  });
});

describe("asking the model", () => {
  it("asks three times, with the patches cached, and adds up the cost", async () => {
    const { send, requests } = api([
      verdict("Medium", true),
      verdict("High", true),
      verdict("Medium", false),
    ]);
    const result = await classify([file], { apiKey: "key", fetch: send });
    expect({
      complexity: result.complexity,
      security: result.security,
      votes: result.votes.length,
      cached: requests.every(
        (request) =>
          typeof request === "string" &&
          request.includes('"cache_control":{"type":"ephemeral"}')
      ),
    }).toStrictEqual({
      complexity: "Medium",
      security: true,
      votes: 3,
      cached: true,
    });
    expect(result.cost).toBeGreaterThan(0);
  });

  it("waits out a rate limit and asks again", async () => {
    const { send } = api([
      new Response("slow down", { status: 429 }),
      verdict("Low", false),
      verdict("Low", false),
      verdict("Low", false),
    ]);
    await expect(
      classify([file], { apiKey: "key", fetch: send })
    ).resolves.toMatchObject({ complexity: "Low", security: false });
  }, 20_000);

  it("fails on a refusal rather than reading it as a verdict", async () => {
    const { send } = api([
      Response.json({
        stop_reason: "refusal",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    ]);
    await expect(
      classify([file], { apiKey: "key", fetch: send })
    ).rejects.toThrow("no verdict");
  });

  it("fails on an answer outside the labels rather than guessing one", async () => {
    const { send } = api([{ ...verdict("Low", false), complexity: "Trivial" }]);
    await expect(
      classify([file], { apiKey: "key", fetch: send })
    ).rejects.toThrow("Invalid option");
  });

  it("fails on a bad key at once", async () => {
    const { send } = api([new Response("invalid x-api-key", { status: 401 })]);
    await expect(
      classify([file], { apiKey: "key", fetch: send })
    ).rejects.toThrow("answered 401");
  });
});

describe("reading the files GitHub lists", () => {
  it("reads a file without a patch, as GitHub lists a binary one", () => {
    expect(
      parsePatchedFiles(
        '{"filename":"logo.png","previous_filename":null,"additions":0,"deletions":0,"patch":null}\n'
      )
    ).toStrictEqual([
      {
        filename: "logo.png",
        previous_filename: undefined,
        additions: 0,
        deletions: 0,
        patch: undefined,
      },
    ]);
  });

  it("fails on an empty listing rather than calling it Low", () => {
    expect(() => parsePatchedFiles("\n")).toThrow("listing failed");
  });
});
