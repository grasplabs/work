/**
 * The admin's Secrets Store in the test pool, filled for each test as
 * deploy-platform fills it (wrangler.jsonc), and emptied after.
 */
import { afterEach, beforeEach } from "vite-plus/test";

import { adminOf, adminSecrets } from "./secrets-store-admin.ts";
import type { SecretsStoreAdmin } from "./secrets-store-admin.ts";

/**
 * Sets the secret `binding` names, `name` in the store, to `value`, as
 * deploy-platform does after a rotation in 1Password: kept under its id, so
 * it's taken out after the test as usual.
 */
export const setStoreSecret = async (
  binding: SecretsStoreSecret,
  name: string,
  value: string
): Promise<void> => {
  const admin = await adminOf(binding);
  const secrets = await admin.list();
  const id = secrets.find((secret) => secret.name.endsWith(name))?.metadata
    ?.uuid;
  if (id === undefined) {
    throw new Error(`${name} isn't in the store`);
  }
  await admin.update(value, id);
};

/** Empties the secret `binding` names, `name` in the store, as a store missing it reads. */
export const emptyStoreSecret = async (
  binding: SecretsStoreSecret,
  name: string
): Promise<void> => {
  await setStoreSecret(binding, name, "");
};

/**
 * Puts every secret the admin reads in the store before each test, the
 * deployer's token as given, and takes them out after.
 */
export const useStoreSecrets = (tokens: { deployer: string }): void => {
  const stored: { admin: SecretsStoreAdmin; id: string }[] = [];
  beforeEach(async () => {
    for (const [binding, value] of adminSecrets(tokens)) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      const admin = await adminOf(binding);
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      stored.push({ admin, id: await admin.create(value) });
    }
  });
  afterEach(async () => {
    for (const { admin, id } of stored.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await admin.delete(id);
    }
  });
};
