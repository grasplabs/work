/**
 * Prints one of the platform's Cloudflare names for a stage, as the
 * shared names module (`@grasp-os/shared/names`) gives it, so a workflow
 * names nothing itself:
 *
 *   node scripts/platform-names.ts <staging|production> <name>
 *   node scripts/platform-names.ts <staging|production> storeSecret <NAME>
 *
 * the second giving secret NAME's name in the account's Secrets Store.
 */
import {
  adminDatabaseName,
  clientsNamespace,
  platformWorkerName,
  releasesBucketName,
  routerHostsName,
  stageOf,
  storeSecretName,
} from "@grasp-os/shared/names";

const [stageArg, name, secret] = process.argv.slice(2);
if (stageArg !== "staging" && stageArg !== "production") {
  throw new Error("Name a stage: staging or production");
}
const stage = stageOf(stageArg);
const names: Record<string, string> = {
  admin: platformWorkerName("admin", stage),
  router: platformWorkerName("router", stage),
  adminDatabase: adminDatabaseName(stage),
  releasesBucket: releasesBucketName(stage),
  routerHosts: routerHostsName(stage),
  clientsNamespace: clientsNamespace(stage),
};
const secretPattern = /^[A-Z][A-Z0-9_]*$/u;

/** What was asked for: a store secret's name, or one of `names`. */
const answer = (): string => {
  if (name === "storeSecret") {
    if (secret === undefined || !secretPattern.test(secret)) {
      throw new Error("Name the secret: storeSecret <NAME>");
    }
    return storeSecretName(secret, stage);
  }
  const found = name === undefined ? undefined : names[name];
  if (found === undefined) {
    throw new Error(
      `Name one of: ${Object.keys(names).join(", ")}, storeSecret <NAME>`
    );
  }
  return found;
};

console.log(answer());
