/**
 * Prints one of the platform's Cloudflare names or ids for a stage, as the
 * shared names module (`@grasp-os/shared/names`) gives it, so a workflow
 * names nothing itself:
 *
 *   node scripts/platform-names.ts <staging|production> <name>
 */
import {
  adminDatabaseName,
  clientsNamespace,
  platformAccountId,
  platformR2Endpoint,
  platformSecretsStoreId,
  platformWorkerName,
  releasesBucketName,
  routerHostsName,
  stageNamed,
} from "@grasp-os/shared/names";

const [stageArg, name] = process.argv.slice(2);
const stage = stageNamed(stageArg);
if (stage === undefined) {
  throw new Error("Name a stage: staging or production");
}
const names: Record<string, string> = {
  admin: platformWorkerName("admin", stage),
  router: platformWorkerName("router", stage),
  adminDatabase: adminDatabaseName(stage),
  releasesBucket: releasesBucketName(stage),
  routerHosts: routerHostsName(stage),
  clientsNamespace: clientsNamespace(stage),
  accountId: platformAccountId,
  secretsStoreId: platformSecretsStoreId,
  r2Endpoint: platformR2Endpoint,
};
const found = name === undefined ? undefined : names[name];
if (found === undefined) {
  throw new Error(`Name one of: ${Object.keys(names).join(", ")}`);
}
console.log(found);
