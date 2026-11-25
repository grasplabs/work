import { createContext, createElement, use } from "react";
import type { ReactNode } from "react";

import type { GraspClient } from "../client-core.ts";

const ClientContext = createContext<GraspClient | null>(null);

/**
 * Hands `client` to the page below it. The platform mounts it once per
 * App session (page-runtime.ts); App code never does.
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
      "There is no Grasp client here: the platform mounts it around every page."
    );
  }
  return client;
};
