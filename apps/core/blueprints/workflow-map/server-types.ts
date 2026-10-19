// What `#grasp/server` is to the map's server code here, for the repo's
// type check and lint: the module the host generates for an App
// (`serverModuleSource`, @grasp-os/sdk's generate.ts), whose code is the
// same for every App and whose types come from the App's own schema.ts.
// Never part of the App: its seal generates the real one, and type-checks
// its server code against it.
import type { Id as SdkId } from "@grasp-os/sdk";
import type { Doc as SdkDoc } from "@grasp-os/sdk/database";
import { serverModule } from "@grasp-os/sdk/server";
import type {
  ActionCtx as SdkActionCtx,
  MutationCtx as SdkMutationCtx,
  QueryCtx as SdkQueryCtx,
  Use,
} from "@grasp-os/sdk/server";

import schema from "./files/schema.ts";

type Tables = (typeof schema)["tables"];

const server = serverModule(schema);

export const {
  query,
  internalQuery,
  mutation,
  internalMutation,
  action,
  internalAction,
  doc,
} = server;

/** The names of the App's tables. */
export type TableName = Extract<keyof Tables, string>;
/** The ID of a record of table `Table`. */
export type Id<Table extends TableName> = SdkId<Table>;
/** A record of table `Table`, as a read returns it. */
export type Doc<Table extends TableName> = SdkDoc<Tables[Table], Table>;
export type QueryCtx = SdkQueryCtx<Tables>;
export type MutationCtx<Uses extends readonly Use[] = readonly []> =
  SdkMutationCtx<Tables, Uses>;
export type ActionCtx<Uses extends readonly Use[] = readonly []> =
  SdkActionCtx<Uses>;
