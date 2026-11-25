import { sha256Hex } from "@grasp-os/shared/encoding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { Onboarding, onboardingStore } from "../src/onboarding/store.ts";

// `/interview#dev` on a local stack (src/onboarding/dev-reset.ts): an
// interview that opens whatever state the onboarding is in, for whoever is
// signed in. The ways it can fail, tried here:
//
// - The object making a link, or a list, anywhere but a local stack.
// - A stack with no list, plan or agreements yet having nothing to open.
// - Another account signed in being told the link opens nothing.

const secretOf = (path: string): string => path.split("#")[1] ?? "";

describe("the local stack's interview link", () => {
  it("is nothing anywhere but a local stack", async () => {
    await expect(
      onboardingStore(env).devLinkFor("noor@acme.test")
    ).resolves.toBeNull();
  });

  it("opens Noor's interview on an empty stack, for any account", async () => {
    const stub = onboardingStore(env);
    await runInDurableObject(stub, async (_store, state) => {
      const local = new Onboarding(state, {
        ...env,
        DEV_SKIP_ROUTER_SECRET: "true",
      });
      const path = await local.devLinkFor("someone@elsewhere.test");
      expect(path).toMatch(/^\/interview#[A-Za-z0-9_-]{43}$/u);
      const mark = await sha256Hex(secretOf(path ?? ""));
      const first = local.openLink(mark, {
        account: "account-1",
        address: "someone@elsewhere.test",
      });
      expect(first.ok && first.value.name).toBe("Noor");
      const second = local.openLink(mark, {
        account: "account-2",
        address: "admin@acme.test",
      });
      expect(second.ok).toBeTruthy();
      // Asked again, the same link.
      await expect(local.devLinkFor("")).resolves.toBe(path);
    });
  });
});
