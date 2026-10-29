/**
 * Prints one of the platform's Cloudflare names for a stage, as the
 * shared names module (`@grasp-os/shared/names`) gives it, so a workflow
 * names nothing itself:
 *
 *   node scripts/platform-names.ts <staging|production> <name>
 */
import {
  adminDatabaseName,
  clientsNamespace,
  platformWorkerName,
  releasesBucketName,
  routerHostsName,
  stageOf,
} from "@grasp-os/shared/names";

const [stageArg, name] = process.argv.slice(2);
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
const found = name === undefined ? undefined : names[name];
if (found === undefined) {
  throw new Error(`Name one of: ${Object.keys(names).join(", ")}`);
}
console.log(found);
