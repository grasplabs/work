// What `@server/_generated/server` is to the intake's server code here, for
// the repo's type check and lint: the module the host generates for an
// App (`serverModuleSource`, @grasp-os/runtime's generate.ts), whose code is
// the same for every App and whose types come from the App's own
// schema.ts. A stand-in for the repo only: an App's own is the one every
// save generates among its files (`server/_generated/server.ts`), and its
// seal generates it again and type-checks its server code against it.
import type { Id as SdkId } from "@grasp-os/sdk";
import type {
  Doc as SdkDoc,
  ActionCtx as SdkActionCtx,
  MutationCtx as SdkMutationCtx,
  QueryCtx as SdkQueryCtx,
} from "@grasp-os/sdk/server";
import { serverModule } from "@grasp-os/sdk/server";

import config from "./files/grasp.config.ts";
import schema from "./files/server/schema.ts";

export type { CallerCtx } from "@grasp-os/sdk/server";

type DataModel = (typeof schema)["tables"];

const server = serverModule(schema, config);

/** What the App's permissions grant its functions. */
type Grants = NonNullable<(typeof config)["~grants"]>;

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
export type TableName = Extract<keyof DataModel, string>;
/** The ID of a record of table `Table`. */
export type Id<Table extends TableName> = SdkId<Table>;
/** A record of table `Table`, as a read returns it. */
export type Doc<Table extends TableName> = SdkDoc<DataModel[Table], Table>;
export type QueryCtx = SdkQueryCtx<DataModel>;
export type MutationCtx = SdkMutationCtx<DataModel, Grants>;
export type ActionCtx = SdkActionCtx<Grants>;
