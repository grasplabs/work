import {
  deployedModelKey,
  modelBlobKey,
  releaseManifestSchema,
} from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { clientProvisions, releases } from "../src/db/schema.ts";
import type { ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { graspAccount } from "./grasp-account.ts";
import { db } from "./hosting.ts";
import { deployPlaced, livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// A release's model files, put in each client's own models bucket by its
// deploy (src/deploy/model-files.ts), on the fake Cloudflare API. What can
// go wrong (the threat model on GRA-1772), each tried below:
// - A deployment comes up with nothing for its embedder to load.
// - Bytes that aren't the release's reach a client's bucket, whole or in
//   part.
// - A file goes to another client's bucket, or any bucket but the one
//   core binds for them.
// - Every deploy copies 100 MB again.
// - Old files pile up, or a file goes while the release running, or the
//   one a failed probe rolls back to, still names it; or one that went
//   isn't there when an older release is deployed again.

const token = "test-deployer-token-model-files-4b7e21";
const cloudflare = mockCloudflareApi(token);

/** A model's three files, distinct by `tag`. */
const model = (tag: string): Record<string, string> => ({
  [`${tag}/tokenizer`]: `tokenizer of ${tag} ${crypto.randomUUID()}`,
  [`${tag}/encoder`]: `encoder of ${tag} ${crypto.randomUUID()}`,
  [`${tag}/tokens`]: `tokens of ${tag} ${crypto.randomUUID()}`,
});

/** The hashes of a release's model files. */
const hashesOf = async (releaseId: string): Promise<string[]> => {
  const [row] = await db
    .select({ manifest: releases.manifest })
    .from(releases)
    .where(eq(releases.id, releaseId));
  const manifest = releaseManifestSchema.parse(JSON.parse(row?.manifest ?? ""));
  return manifest.modelFiles.map(({ sha256 }) => sha256);
};

/** A model whose tokens file is `size` bytes: read from R2 in several pieces. */
const largeModel = (tag: string, size: number): Record<string, string> => ({
  ...model(tag),
  [`${tag}/tokens`]: `${tag} `.padEnd(size, "x"),
});

/** The bytes client `deploymentId`'s models bucket holds, as text, by key. */
const heldBy = (
  account: ReturnType<typeof graspAccount>,
  deploymentId: string
): Record<string, string> =>
  Object.fromEntries(
    [...(account.objects.get(`grasp-${deploymentId}-core-models`) ?? [])].map(
      ([key, bytes]) => [key, new TextDecoder().decode(bytes)]
    )
  );

const isObjectPut = (call: ApiCall): boolean =>
  call.method === "PUT" && call.path.includes("/objects/");

describe("a release's model files in each deployment", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(() => {
    // Attempts log why they stopped.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("puts every file a release names in the client's own models bucket, byte for byte, in the EU", async () => {
    const files = model("a");
    const release = await placedRelease("feat(core): a model", {
      modelFiles: files,
    });

    const { account, deploymentId } = await livePlacedClient(
      cloudflare,
      release
    );

    const bucket = `grasp-${deploymentId}-core-models`;
    expect(
      account.buckets.find(({ name }) => name === bucket)?.jurisdiction
    ).toBe("eu");
    const decoded = Object.fromEntries(
      [...(account.objects.get(bucket) ?? [])].map(([key, bytes]) => [
        key,
        new TextDecoder().decode(bytes),
      ])
    );
    const hashes = await hashesOf(release);
    expect(Object.keys(decoded).toSorted()).toStrictEqual(
      hashes.map((hash) => deployedModelKey(hash)).toSorted()
    );
    expect(Object.values(decoded).toSorted()).toStrictEqual(
      Object.values(files).toSorted()
    );
    // Nothing anywhere else: no other bucket got an object.
    expect([...account.objects.keys()]).toStrictEqual([bucket]);
  });

  it("copies nothing again for a release that keeps its model", async () => {
    const files = model("b");
    const first = await placedRelease("feat(core): b", { modelFiles: files });
    const { clientId } = await livePlacedClient(cloudflare, first);
    const second = await placedRelease("fix(core): b again", {
      modelFiles: files,
    });
    const before = cloudflare.calls.filter(isObjectPut).length;

    await deployPlaced(clientId, second);

    expect(cloudflare.calls.filter(isObjectPut)).toHaveLength(before);
  });

  it("keeps the files of the release running before, removes older ones, and copies them back for a release that names them again", async () => {
    const first = await placedRelease("feat(core): model one", {
      modelFiles: model("one"),
    });
    const { clientId, account, deploymentId } = await livePlacedClient(
      cloudflare,
      first
    );
    const bucket = `grasp-${deploymentId}-core-models`;
    const keys = (): string[] =>
      [...(account.objects.get(bucket)?.keys() ?? [])].toSorted();
    const keysOf = async (releaseId: string): Promise<string[]> => {
      const hashes = await hashesOf(releaseId);
      return hashes.map((hash) => deployedModelKey(hash));
    };
    const two = model("two");
    const second = await placedRelease("feat(core): model two", {
      modelFiles: two,
    });
    const third = await placedRelease("fix(core): still model two", {
      modelFiles: two,
    });

    await deployPlaced(clientId, second);
    const afterSecond = keys();
    await deployPlaced(clientId, third);
    const afterThird = keys();
    await deployPlaced(clientId, first);
    const afterFirstAgain = keys();

    // The new model beside the one a failed probe would roll back to.
    expect(afterSecond).toStrictEqual(
      [...(await keysOf(first)), ...(await keysOf(second))].toSorted()
    );
    // Neither the release running nor the one before names model one.
    const secondKeys = await keysOf(second);
    expect(afterThird).toStrictEqual(secondKeys.toSorted());
    // An older release deployed again has its own files again.
    expect(afterFirstAgain).toStrictEqual(
      [...(await keysOf(first)), ...(await keysOf(second))].toSorted()
    );
  });

  it("copies nothing, and goes no further, when a file in the releases bucket isn't the release's", async () => {
    const release = await placedRelease("feat(core): tampered", {
      modelFiles: model("t"),
    });
    const [hash] = await hashesOf(release);
    if (hash === undefined) {
      throw new Error("expected a model file");
    }
    // Other bytes of the same size, under the release's hash.
    const stored = await env.RELEASES.get(modelBlobKey(hash));
    const size = stored?.size ?? 0;
    await stored?.body.cancel();
    await env.RELEASES.put(modelBlobKey(hash), "x".repeat(size));

    const outcome = await livePlacedClient(cloudflare, release).then(
      () => "live",
      () => "stopped"
    );

    const operations = await db
      .select({ error: clientProvisions.error, step: clientProvisions.step })
      .from(clientProvisions)
      .where(eq(clientProvisions.releaseId, release));
    expect(outcome).toBe("stopped");
    expect(operations).toStrictEqual([
      { error: "release_blob_mismatch", step: "resources" },
    ]);
    const copiedHashes = [...graspAccount(cloudflare).objects.values()].flatMap(
      (objects) => [...objects.keys()]
    );
    expect(copiedHashes).not.toContain(deployedModelKey(hash));
    // Neither Worker was uploaded.
    expect(
      cloudflare.calls.filter(
        (call) => call.method === "PUT" && call.path.includes("/scripts/")
      )
    ).toStrictEqual([]);
  });

  it("tries an upload again after the connection is lost partway through its body", async () => {
    const files = largeModel("cut", 1024 * 1024);
    const release = await placedRelease("feat(core): a cut upload", {
      modelFiles: files,
    });
    const hashes = await hashesOf(release);
    const tokensHash = hashes.at(-1);
    const tokensPut = (call: ApiCall): boolean =>
      isObjectPut(call) &&
      call.path.endsWith(deployedModelKey(tokensHash ?? ""));
    cloudflare.failNext(tokensPut, "mid-body");

    const { account, deploymentId } = await livePlacedClient(
      cloudflare,
      release
    );

    expect(cloudflare.calls.filter(tokensPut)).toHaveLength(2);
    expect(
      Object.values(heldBy(account, deploymentId)).toSorted()
    ).toStrictEqual(Object.values(files).toSorted());
  });

  it("tries an upload again when reading it from the releases bucket breaks partway", async () => {
    const files = largeModel("flaky", 1024 * 1024);
    const release = await placedRelease("feat(core): a flaky read", {
      modelFiles: files,
    });
    const hashes = await hashesOf(release);
    const tokensHash = hashes.at(-1);
    const key = modelBlobKey(tokensHash ?? "");
    const get = env.RELEASES.get.bind(env.RELEASES);
    let broken = 0;
    vi.spyOn(env.RELEASES, "get").mockImplementation(async (asked, options) => {
      const object = await get(asked, options);
      if (
        asked !== key ||
        broken > 0 ||
        object === null ||
        !("body" in object)
      ) {
        return object;
      }
      broken += 1;
      // Its first piece, then the read breaks, however many pieces it has.
      let passed = false;
      const body = object.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (piece, controller) => {
            if (passed) {
              throw new Error("R2 read broke");
            }
            passed = true;
            controller.enqueue(piece.slice(0, 1));
          },
          flush: () => {
            throw new Error("R2 read broke");
          },
        })
      );
      return new Proxy(object, {
        get: (target, property): unknown =>
          property === "body" ? body : Reflect.get(target, property, target),
      });
    });

    const { account, deploymentId } = await livePlacedClient(
      cloudflare,
      release
    );

    expect(broken).toBe(1);
    expect(
      Object.values(heldBy(account, deploymentId)).toSorted()
    ).toStrictEqual(Object.values(files).toSorted());
  });

  it("removes a file a crashed deploy left behind, never one the running release names", async () => {
    const files = model("kept");
    const first = await placedRelease("feat(core): kept", {
      modelFiles: files,
    });
    const { clientId, account, deploymentId } = await livePlacedClient(
      cloudflare,
      first
    );
    // Copied by a deploy that died before anything named it.
    const left = deployedModelKey("f".repeat(64));
    account.objects
      .get(`grasp-${deploymentId}-core-models`)
      ?.set(left, new TextEncoder().encode("left behind"));
    const again = await placedRelease("fix(core): kept again", {
      modelFiles: files,
    });

    await deployPlaced(clientId, again);

    const held = heldBy(account, deploymentId);
    expect(Object.keys(held)).not.toContain(left);
    expect(Object.values(held).toSorted()).toStrictEqual(
      Object.values(files).toSorted()
    );
  });

  it("deploys a release that names no model, copying nothing and passing its probe", async () => {
    const release = await placedRelease("feat(core): no model yet", {
      modelFiles: {},
    });

    const { account, deploymentId } = await livePlacedClient(
      cloudflare,
      release
    );

    expect(heldBy(account, deploymentId)).toStrictEqual({});
    expect(cloudflare.calls.filter(isObjectPut)).toStrictEqual([]);
  });
});
