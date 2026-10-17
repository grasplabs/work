import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  deploySecrets,
  MissingStoreSecretError,
} from "../src/deploy/context.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// The shared secrets a deploy gives the Workers, from Secrets Store: one
// missing stops the deploy, but for those connect does without, so a store
// that doesn't have one yet never stops every client's deploy.

describe("a deploy's shared secrets", () => {
  useStoreSecrets({ deployer: "deployer-token", tenant: "tenant-token" });

  it("give connect no app OAuth clients while the store has none, and stop on any other one missing", async () => {
    await emptyStoreSecret(env.APP_OAUTH_CLIENTS, "APP_OAUTH_CLIENTS");
    const { shared } = await deploySecrets(env);
    await emptyStoreSecret(env.COMPOSIO_API_KEY, "COMPOSIO_API_KEY");
    await expect(deploySecrets(env)).rejects.toBeInstanceOf(
      MissingStoreSecretError
    );
    expect(shared.connect).toMatchObject({
      APP_OAUTH_CLIENTS: "{}",
      COMPOSIO_API_KEY: "composio-key",
    });
  });
});
