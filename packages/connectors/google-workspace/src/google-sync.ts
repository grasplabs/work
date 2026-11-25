import { providerFetch } from "@grasp-os/runtime/connector";

import { googleErrors } from "./google.ts";

// Google, as the syncs reach it: plain `fetch` through connect's egress,
// Google's error answers read as the connector's `googleErrors` says.
// Only the syncs import this, until they move to the SDK too.

type Query = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * A Google URL: the path as given, with the query's set values (a list
 * sends the parameter once for each), and a page token if one is given.
 */
export const googleUrl = (
  host: string,
  path: string,
  query: Query = {},
  page?: string
): URL => {
  const url = new URL(`https://${host}${path}`);
  for (const [name, value] of Object.entries(query)) {
    for (const each of typeof value === "string" ? [value] : (value ?? [])) {
      url.searchParams.append(name, each);
    }
  }
  if (page !== undefined) {
    url.searchParams.set("pageToken", page);
  }
  return url;
};

const google = providerFetch({
  name: "Google",
  errorCodeOf: googleErrors.code,
  isThrottled: googleErrors.isThrottled,
  invalidStatuses: googleErrors.invalid,
});

/** The ToolError Google's answer to a GET that isn't a success stands for. */
export const googleFailure = google.failure;
