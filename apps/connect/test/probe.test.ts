import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { connectWith } from "./connect.ts";

// Connect's half of the admin's provisioning probe (src/probe.ts), which
// core asks over its service binding before the admin routes a client:
// each of connect's private bindings answers a no-op, or says it didn't,
// without why.

/** `binding`, failing every use with `reason`, as one not deployed would. */
const down = <T extends object>(binding: T, reason: string): T =>
  new Proxy(binding, {
    get: () => {
      throw new Error(reason);
    },
  });

describe("connect's provisioning probe", () => {
  it("says its database and its sandbox each answer", async () => {
    await expect(exports.default.probeBindings()).resolves.toStrictEqual({
      DB: true,
      LOADER: true,
    });
  });

  it("says which binding didn't answer, without why", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answer = await connectWith({
      DB: down(env.DB, "database 7e21c0 is gone"),
      LOADER: down(env.LOADER, "loader 3a9f44 is off"),
    }).probeBindings();
    const logged = JSON.stringify(warnings.mock.calls);
    warnings.mockRestore();

    expect(answer).toStrictEqual({ DB: false, LOADER: false });
    expect(logged).not.toContain("7e21c0");
    expect(logged).not.toContain("3a9f44");
  });
});
