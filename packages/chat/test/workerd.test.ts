// The fix for adapters that send through axios (src/workerd.ts): workerd
// refuses `cache: "default"`, which axios' fetch adapter sets on every
// request. Importing the fix before axios, as a Worker's entry does, lets
// axios send; other cache modes still reach workerd as they were.
import { describe, expect, it, vi } from "vite-plus/test";

const url = "https://api.example.test/send";

/** workerd's refusal of a cache mode it doesn't implement. */
const unsupported: unknown = expect.stringContaining("Unsupported cache mode");

/**
 * What constructing a request with `cache` does: its mode, or the error.
 * workerd's types list only the modes it implements, so the mode is set
 * untyped, as axios sets it.
 */
const construct = (cache: string) => {
  const init: RequestInit = {};
  Reflect.set(init, "cache", cache);
  try {
    return new Request(url, init).cache;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("sending from workerd through axios-based adapters", () => {
  it("lets axios, loaded after the fix, send a request; other cache modes stay workerd's", async () => {
    const refusedBefore = construct("default");
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      sent.push(input instanceof Request ? input.url : String(input));
      return await Promise.resolve(Response.json({ ok: true }));
    });
    // As a Worker's entry orders them: the fix, then what loads axios.
    await import("../src/workerd.ts");
    const { default: axios } = await import("axios");

    const response = await axios.post<unknown>(
      url,
      { text: "hi" },
      { adapter: "fetch" }
    );

    expect({
      refusedBefore,
      after: construct("default"),
      reload: construct("reload"),
      sent,
      answer: response.data,
    }).toStrictEqual({
      refusedBefore: unsupported,
      after: undefined,
      reload: unsupported,
      sent: [url],
      answer: { ok: true },
    });
  });
});
