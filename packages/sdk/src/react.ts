/**
 * The React SDK of an App's screens (spec 10.1, 10.7.1): the platform's
 * session client in a component, and the App's queries, mutations and
 * actions through the references the host generated for it (`#grasp`).
 *
 * ```tsx
 * import { useMutation, useQuery } from "@grasp-os/sdk/react";
 * import { api } from "#grasp";
 *
 * export default function Notes() {
 *   const notes = useQuery(api.notes.list, { pagination: { pageSize: 50 } });
 *   const create = useMutation(api.notes.create);
 *   if (notes === undefined) return <p role="status">Loading notes…</p>;
 *   …
 * }
 * ```
 *
 * The platform mounts one `GraspProvider` per App session; a screen never
 * makes a client or mounts a provider. Queries answer their declared
 * value directly, or `undefined` while loading or skipped (`"skip"`): a
 * `null` result is the App's data. A query's failure is thrown while
 * rendering, to the platform's error boundary; a mutation's or action's
 * rejects its promise.
 */
import { createContext, createElement, use, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { clientInternals, loading } from "./client-core.ts";
import type {
  ActionReference,
  CallArguments,
  GraspClient,
  MutationReference,
  QueryReference,
  QuerySnapshot,
  SubmitOptions,
} from "./client-core.ts";
import type { ArgsOf, ReturnOf } from "./references.ts";

export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type { QueryOptions, SubmitOptions } from "./client-core.ts";

const ClientContext = createContext<GraspClient | null>(null);

/**
 * Hands `client` to the screen below it. The platform mounts it once per
 * App session (screen-runtime.ts); App code never does.
 */
export const GraspProvider = ({
  client,
  children,
}: {
  client: GraspClient;
  children?: ReactNode;
}): ReactNode => createElement(ClientContext, { value: client }, children);

/**
 * The App session's client, for calls made from event handlers:
 * `client.query`, `client.mutation` and `client.action`.
 */
export const useClient = (): GraspClient => {
  const client = use(ClientContext);
  if (client === null) {
    throw new Error(
      "There is no Grasp client here: the platform mounts it around every screen."
    );
  }
  return client;
};

/** A mutation or action as a function: its arguments, then its options. */
export type OperationCallable<Reference> = (
  ...args: CallArguments<Reference, SubmitOptions>
) => Promise<ReturnOf<Reference>>;

const noSubscription = (): (() => void) => () => {
  // Nothing to stop: a skipped query reads nothing.
};

/**
 * The current result of the query `reference` names with `args`, kept up
 * to date: its declared value, or `undefined` while it loads or when
 * `args` is `"skip"`. Check for loading with `=== undefined`. A failure
 * is thrown to the screen's error boundary.
 */
export const useQuery = <Reference extends QueryReference>(
  reference: Reference,
  args: ArgsOf<Reference> | "skip"
): ReturnOf<Reference> | undefined => {
  const internals = clientInternals(useClient());
  const entry = args === "skip" ? undefined : internals.entry(reference, args);
  const snapshot: QuerySnapshot = useSyncExternalStore(
    (onChange) =>
      entry === undefined
        ? noSubscription()
        : internals.subscribe(entry, onChange),
    () => entry?.snapshot ?? loading
  );
  if (snapshot.error !== undefined) {
    throw snapshot.error;
  }
  // SAFETY: the host validated the value against the reference's declared
  // return, which `Reference` carries as its type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return snapshot.value as ReturnOf<Reference> | undefined;
};

/**
 * The mutation `reference` names, as a stable function: each call is one
 * logical submission, resolving with the declared result once the host
 * confirms its commit.
 */
export const useMutation = <Reference extends MutationReference>(
  reference: Reference
): OperationCallable<Reference> => {
  const client = useClient();
  return async (...args) => await client.mutation(reference, ...args);
};

/**
 * The action `reference` names, as a stable function, resolving with its
 * declared result. A lost response is never sent again on its own.
 */
export const useAction = <Reference extends ActionReference>(
  reference: Reference
): OperationCallable<Reference> => {
  const client = useClient();
  return async (...args) => await client.action(reference, ...args);
};
