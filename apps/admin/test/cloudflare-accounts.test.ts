import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { createD1Database } from "../src/cloudflare/accounts.ts";
import {
  CloudflareApiError,
  cloudflareApi,
  listAll,
} from "../src/cloudflare/api.ts";
import type { CloudflareApi } from "../src/cloudflare/api.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
/** No waiting between retries: the fake answers at once. */
const api = cloudflareApi({ token, retryDelayMs: 0 });
const accountSchema = z.object({ id: z.string(), name: z.string() });

/** The account `accountId`, as the token sees it: a plain read. */
const getAccount = async (client: CloudflareApi, accountId: string) =>
  await client.call(
    { method: "GET", path: `/accounts/${accountId}` },
    accountSchema
  );

/** What `promise` fails with, or undefined if it doesn't. */
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("accounts", () => {
  it("reads an account the token is a member of", async () => {
    const account = cloudflare.addAccount("Acme");
    await expect(getAccount(api, account.id)).resolves.toStrictEqual({
      id: account.id,
      name: "Acme",
    });
  });

  it("lists every account page by page", async () => {
    for (let index = 0; index < 58; index += 1) {
      cloudflare.addAccount(`Client ${index}`);
    }
    const listed = await listAll(api, "/accounts", accountSchema, {
      name: "Client",
    });
    expect({
      listed: listed.length,
      pages: cloudflare.calls.map(({ query }) => query.get("page")),
    }).toStrictEqual({ listed: 58, pages: ["1", "2"] });
  });

  it("fails a list longer than it walks, rather than return part of it", async () => {
    for (let index = 0; index <= 1000; index += 1) {
      cloudflare.addAccount(`Client ${index}`);
    }
    await expect(
      listAll(api, "/accounts", accountSchema, { name: "Client" })
    ).rejects.toThrow("Listing /accounts passed 20 pages");
  });

  it("refuses an account the token isn't a member of", async () => {
    await expect(
      getAccount(api, "someone-elses-account")
    ).rejects.toMatchObject({
      status: 403,
      codes: [9109],
    });
  });
});

describe("answers as Cloudflare sends them", () => {
  it("takes a success whose errors, messages and result info are null", async () => {
    const account = cloudflare.addAccount("Acme");
    // An assets upload session answers this way on a real account (GRA-430).
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        success: true,
        errors: null,
        messages: null,
        result_info: null,
        result: { id: account.id, name: "Acme" },
      })
    );
    await expect(getAccount(api, account.id)).resolves.toMatchObject({
      id: account.id,
      name: "Acme",
    });
  });

  it("still refuses a failure whose errors are null, saying only its status", async () => {
    const account = cloudflare.addAccount("Acme");
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { success: false, errors: null, messages: null, result: null },
        { status: 400 }
      )
    );
    const error = await errorOf(getAccount(api, account.id));
    expect(
      error instanceof CloudflareApiError
        ? { status: error.status, codes: error.codes }
        : error
    ).toStrictEqual({ status: 400, codes: [] });
  });

  it("still refuses a success flag on a non-2xx answer", async () => {
    const account = cloudflare.addAccount("Acme");
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { success: true, errors: null, result: { id: account.id } },
        { status: 403 }
      )
    );
    await expect(errorOf(getAccount(api, account.id))).resolves.toBeInstanceOf(
      CloudflareApiError
    );
  });
});

describe("retries", () => {
  it("fails a rate-limited call at once, never sending it again, and keeps until when it said to wait", async () => {
    const account = cloudflare.addAccount();
    const fresh = cloudflareApi({ token, retryDelayMs: 0 });
    cloudflare.failCall(1, { retryAfter: "7" });
    const sentAt = Date.now();
    await expect(
      createD1Database(fresh, account.id, "grasp-os-core", "eu")
    ).rejects.toMatchObject({ status: 429, codes: [971] });
    const { blockedUntil } = fresh.usage();
    expect({
      sent: cloudflare.calls.map(({ method }) => method),
      created: account.d1.length,
      waitsAtLeast: (blockedUntil?.getTime() ?? 0) - sentAt >= 7000,
    }).toStrictEqual({ sent: ["POST"], created: 0, waitsAtLeast: true });
  });

  it("counts a 429 that names no wait as Cloudflare's five-minute block", async () => {
    const account = cloudflare.addAccount();
    const fresh = cloudflareApi({ token, retryDelayMs: 0 });
    cloudflare.failCall(1, 429);
    const sentAt = Date.now();
    await expect(getAccount(fresh, account.id)).rejects.toMatchObject({
      status: 429,
    });
    expect(
      (fresh.usage().blockedUntil?.getTime() ?? 0) - sentAt
    ).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("keeps the last Ratelimit header an answer carried, and counts every call", async () => {
    const account = cloudflare.addAccount("Acme");
    const fresh = cloudflareApi({ token, retryDelayMs: 0 });
    cloudflare.failCall(1, 503);
    await getAccount(fresh, account.id);
    await getAccount(fresh, account.id);
    const usage = fresh.usage();
    expect({
      calls: usage.calls,
      rated: usage.rated,
      header: usage.header,
      remaining: usage.limit?.remaining,
      blockedUntil: usage.blockedUntil,
    }).toStrictEqual({
      calls: 3,
      rated: 3,
      header: `"default";r=${cloudflare.rateLimit.remaining};t=300`,
      remaining: cloudflare.rateLimit.remaining,
      blockedUntil: null,
    });
  });

  it("retries a read after a server error or no answer", async () => {
    const account = cloudflare.addAccount("Acme");
    cloudflare.failCall(1, 502);
    cloudflare.failCall(2, 503);
    cloudflare.failCall(3, "network");
    await expect(getAccount(api, account.id)).resolves.toMatchObject({
      name: "Acme",
    });
    expect(cloudflare.calls).toHaveLength(4);
  });

  it("doesn't retry a create that may have gone through", async () => {
    const account = cloudflare.addAccount();
    cloudflare.failCall(1, 500);
    await expect(
      createD1Database(api, account.id, "grasp-os-core", "eu")
    ).rejects.toMatchObject({ status: 500, codes: [10_000] });
    expect(cloudflare.calls.map(({ method }) => method)).toStrictEqual([
      "POST",
    ]);
  });

  it("gives up after four attempts, waiting twice as long each time", async () => {
    const account = cloudflare.addAccount();
    // Waits are counted, not waited.
    const wait = vi.spyOn(scheduler, "wait").mockResolvedValue();
    const slow = cloudflareApi({ token, retryDelayMs: 100 });
    for (const n of [1, 2, 3, 4]) {
      cloudflare.failCall(n, 503);
    }
    await expect(getAccount(slow, account.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(cloudflare.calls).toHaveLength(4);
    expect(wait.mock.calls).toStrictEqual([[100], [200], [400]]);
  });

  it("reports an answer without the API's envelope by its status", async () => {
    const account = cloudflare.addAccount();
    for (const n of [1, 2, 3, 4]) {
      cloudflare.failCall(n, 502);
    }
    await expect(getAccount(api, account.id)).rejects.toThrow(
      `Cloudflare API GET /accounts/${account.id} failed (502)`
    );
  });
});

describe("the token", () => {
  it("goes only into the Authorization header", async () => {
    const account = cloudflare.addAccount();
    await createD1Database(api, account.id, "grasp-os-core", "eu");
    for (const { headers, path, query } of cloudflare.calls) {
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(`${path}?${query.toString()}`).not.toContain(token);
    }
  });

  it("never shows in an error", async () => {
    const wrong = cloudflareApi({
      token: "wrong-token-9876543210",
      retryDelayMs: 0,
    });
    const account = cloudflare.addAccount();
    const error = await errorOf(getAccount(wrong, account.id));
    expect(error).toBeInstanceOf(CloudflareApiError);
    const shown = `${String(error)} ${JSON.stringify(error)} ${error instanceof Error ? error.stack : ""}`;
    expect(shown).not.toContain("wrong-token-9876543210");
    expect(shown).toContain("10000 Authentication error");
  });
});
