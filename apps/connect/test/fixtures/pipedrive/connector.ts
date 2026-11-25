/**
 * Pipedrive, as a connector generated from its vendor's OpenAPI spec
 * (GRA-2319): tools.gen.ts is the compiler's, from openapi.yaml beside
 * this file (scripts/connector-openapi.ts), and this file adds what no
 * spec says: whose account a key is. A test fixture, not a release
 * connector: an App lists deals through it in core's tests
 * (resource-connectors-openapi.test.ts), against a fake of Pipedrive.
 */
import { auth, defineConnector } from "@grasp-os/sdk/connector";

import { base, hosts, openapi, signIn, tools } from "./tools.gen.ts";

export default defineConnector({
  name: "pipedrive",
  title: "Pipedrive",
  hosts,
  base,
  openapi,
  auth: auth.apiKey({
    ...signIn,
    account: {
      url: "https://api.pipedrive.com/api/v1/users/me",
      id: "/data/id",
      name: "/data/name",
      email: "/data/email",
    },
  }),
  tools,
});
