import { brainMemoryErrors } from "@grasp-os/shared/brain-memories";
import type { BrainShare } from "@grasp-os/shared/brain-memories";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { rememberAs } from "../src/brain-next.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// Sharing a memory with everyone (GRA-1815) in a company of fewer than
// three people: the others would know who shared it, so it is refused as
// a team of two is, and not offered. A file of its own: each file starts
// with empty storage, so the company here is only who signs in below.

const idp = mockIdp();

describe("sharing a memory with everyone in a small company", () => {
  it("refuses everyone while the company has fewer than three people, and offers it once it has three", async () => {
    const [anna, ben] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const name = `Tiny ${crypto.randomUUID().slice(0, 8)}`;
    const statement = `${name} renews in March`;
    const { memory, entity } = await rememberAs(env, anna.userId, {
      change: crypto.randomUUID(),
      about: { kind: "customer", names: [name] },
      type: "fact",
      statement,
      quote: statement,
    });
    const share = (): BrainShare => ({
      memory: { entity, memory },
      shown: {
        about: name,
        value: null,
        statement,
        validFrom: null,
        validUntil: null,
      },
      audience: "company",
      change: crypto.randomUUID(),
    });
    const small = await anna.api.brainMemories.shareAudiences();
    await expect(anna.api.brainMemories.publish(share())).rejects.toThrow(
      brainMemoryErrors.create("brain.audience_not_yours").message
    );
    const benFinds = await ben.api.brainMemories.entities("customer");
    await signedInApi(idp, "user");
    const larger = await anna.api.brainMemories.shareAudiences();
    const shared = await anna.api.brainMemories.publish(share());
    expect({
      small: small.company,
      benFinds: benFinds.entities.filter((each) => each.name === name),
      larger: larger.company,
      shared: shared !== null,
    }).toStrictEqual({
      small: false,
      benFinds: [],
      larger: true,
      shared: true,
    });
  });
});
