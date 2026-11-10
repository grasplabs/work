import { banner } from "./codegen-render.ts";

/**
 * `@server/_generated/dataModel`: the data model's types, from
 * `schema.ts` alone. The same for every App, so inspection can load it
 * before anything is generated from the App's manifest.
 */
export const dataModelSource = `${banner}import type { Id as SdkId } from "@grasp-os/sdk";
import type { Doc as SdkDoc } from "@grasp-os/sdk/server";

import type schema from "../schema.ts";

type Tables = (typeof schema)["tables"];

/** The App's tables, by name, as \`schema.ts\` declares them. */
export type DataModel = Tables;
/** The names of the App's tables. */
export type TableName = keyof Tables & string;
/** The ID of a record of table \`Table\`. */
export type Id<Table extends TableName> = SdkId<Table>;
/** A record of table \`Table\`, as a read returns it. */
export type Doc<Table extends TableName> = SdkDoc<Tables[Table], Table>;
`;

/**
 * `@server/_generated/server`: the constructors, specialized to
 * `schema.ts` and to what `grasp.config.ts`'s permissions grant, by type.
 * The same for every App, so inspection can load it before anything is
 * generated from the App's manifest.
 */
export const serverModuleSource = `${banner}import { serverModule } from "@grasp-os/sdk/server";
import type {
  ActionCtx as SdkActionCtx,
  MutationCtx as SdkMutationCtx,
  QueryCtx as SdkQueryCtx,
} from "@grasp-os/sdk/server";

import config from "../../grasp.config.ts";
import schema from "../schema.ts";
import type { DataModel } from "./dataModel.ts";

export type { CallerCtx } from "@grasp-os/sdk/server";
export type { Doc, Id, TableName } from "./dataModel.ts";

const server = serverModule(schema, config);

/** What the App's permissions grant its functions. */
type Grants = NonNullable<(typeof config)["~grants"]>;

export const query = server.query;
export const internalQuery = server.internalQuery;
export const mutation = server.mutation;
export const internalMutation = server.internalMutation;
export const action = server.action;
export const internalAction = server.internalAction;
export const doc = server.doc;

export type QueryCtx = SdkQueryCtx<DataModel>;
export type MutationCtx = SdkMutationCtx<DataModel, Grants>;
export type ActionCtx = SdkActionCtx<Grants>;
`;
