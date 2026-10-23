// The fix for adapters that send through axios (src/workerd.ts): workerd
// refuses `cache: "default"`, which axios' fetch adapter sets on every
// request; with the fix such a request is made as one without a cache mode,
// and any other mode still reaches workerd as it was.
import { describe, expect, it, vi } from "vite-plus/test";

import { allowDefaultCacheMode } from "../src/workerd.ts";

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
  it("makes a request that asks for the default cache mode as one without a mode, and leaves other modes to workerd", async () => {
    const refusedBefore = construct("default");
    const sent: (RequestInit | undefined)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push(init);
      return await Promise.resolve(new Response("sent"));
    });
    allowDefaultCacheMode();
    allowDefaultCacheMode();

    const init: RequestInit = { method: "POST" };
    Reflect.set(init, "cache", "default");
    const response = await fetch(url, init);

    expect({
      refusedBefore,
      after: construct("default"),
      reload: construct("reload"),
      sent,
      answer: await response.text(),
    }).toStrictEqual({
      refusedBefore: unsupported,
      after: undefined,
      reload: unsupported,
      sent: [{ method: "POST" }],
      answer: "sent",
    });
  });
});
