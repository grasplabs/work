import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  deploySecrets,
  MissingStoreSecretError,
} from "../src/deploy/context.ts";
import {
  emptyStoreSecret,
  setStoreSecret,
  useStoreSecrets,
} from "./secrets-store.ts";

/** The admin's env, its store failing to read `APP_OAUTH_CLIENTS` so. */
const answering = (error: Error): Env => ({
  ...env,
  APP_OAUTH_CLIENTS: {
    get: () => {
      throw error;
    },
  },
});

// The shared secrets a deploy gives the Workers, from Secrets Store: one
// missing stops the deploy, but for those connect does without, so a store
// that doesn't have one yet never stops every client's deploy. Grasp's AI
// provider keys are among those: connect gets each the store has, core
// never one.

/** Grasp's AI provider keys, as connect's secrets and the store name them. */
const aiKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/** Which of Grasp's AI keys `secrets` holds, by name. */
const aiKeysIn = (secrets: Readonly<Record<string, string>> = {}): string[] =>
  Object.keys(secrets).filter((name) => aiKeys.some((key) => key === name));

describe("a deploy's shared secrets", () => {
  useStoreSecrets({ deployer: "deployer-token" });

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

  it("stand in for app OAuth clients only when the store doesn't have them, never when it failed to answer", async () => {
    const absent = await deploySecrets(
      answering(new Error('Secret "APP_OAUTH_CLIENTS" not found'))
    );
    await expect(
      deploySecrets(answering(new Error("Secrets Store is unavailable")))
    ).rejects.toBeInstanceOf(MissingStoreSecretError);
    expect(absent.shared.connect).toMatchObject({ APP_OAUTH_CLIENTS: "{}" });
  });

  it("stand in for app OAuth clients when the deploy left them unbound, the store not having them", async () => {
    const unbound: Env = { ...env };
    Reflect.deleteProperty(unbound, "APP_OAUTH_CLIENTS");
    const { shared } = await deploySecrets(unbound);
    expect(shared.connect).toMatchObject({ APP_OAUTH_CLIENTS: "{}" });
  });

  it("give connect each of Grasp's AI provider keys the store has, core none, and leave out the rest", async () => {
    for (const name of aiKeys) {
      // oxlint-disable-next-line no-await-in-loop -- one secret at a time
      await setStoreSecret(env[name], name, `grasp-${name}`);
    }
    const every = await deploySecrets(env);
    await emptyStoreSecret(env.MISTRAL_API_KEY, "MISTRAL_API_KEY");
    const unbound: Env = { ...env };
    Reflect.deleteProperty(unbound, "OPENROUTER_API_KEY");
    const some = await deploySecrets(unbound);

    expect({
      connect: every.shared.connect,
      core: aiKeysIn(every.shared.core),
      some: aiKeysIn(some.shared.connect),
    }).toMatchObject({
      connect: {
        OPENAI_API_KEY: "grasp-OPENAI_API_KEY",
        ANTHROPIC_API_KEY: "grasp-ANTHROPIC_API_KEY",
        MISTRAL_API_KEY: "grasp-MISTRAL_API_KEY",
        OPENROUTER_API_KEY: "grasp-OPENROUTER_API_KEY",
      },
      core: [],
      some: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    });
  });
});
