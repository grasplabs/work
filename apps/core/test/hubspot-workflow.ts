// An independent workflow bound to HubSpot through Composio, as an admin
// connects it and approves the binding: what Grasp's admin snapshot and
// Integrations read of the workflows that use a connection.
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import { composioConsentText } from "@grasp-os/shared/connect";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";

import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import type { Idp } from "./idp.ts";
import { openRpc, routed, signedInWithRole, unique } from "./sign-in.ts";

/** An admin, signed in, with their `connections` and `workflows` APIs and who they are to core. */
export const connectingAdmin = async (idp: Idp) => {
  const { session, userId, person } = await signedInWithRole(idp, "admin");
  const { core } = await openRpc(session);
  const identity: Identity = {
    userId,
    email: String(person.email),
    name: String(person.name),
    role: "admin",
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return {
    session,
    identity,
    connections: core.authenticate().connections,
    workflows: core.authenticate().workflows,
  };
};

type Admin = Awaited<ReturnType<typeof connectingAdmin>>;

/** The provider, or Composio, sending `session`'s browser back to core. */
export const backFromProvider = async (
  session: string,
  query: Record<string, string>
): Promise<void> => {
  await routed(
    `/api/connections/callback?${new URLSearchParams(query).toString()}`,
    { headers: { cookie: session } }
  );
};

/** HubSpot, connected through Composio by `by`: the new connection's ID. */
export const connectHubspot = async (by: Admin): Promise<string> => {
  const { url } = await by.connections.connectToolkit({
    toolkit: "hubspot",
    tools: ["HUBSPOT_LIST_CONTACTS"],
    consent: composioConsentText,
    returnTo: "/integrations",
  });
  const state = new URL(url).searchParams.get("state") ?? "";
  await backFromProvider(by.session, { state, status: "success" });
  const listed = await by.connections.list();
  const hubspot = listed.find(({ provider }) => provider === "hubspot");
  if (hubspot === undefined) {
    throw new Error("HubSpot wasn't connected");
  }
  return hubspot.id;
};

/** A workflow's input or output schema: an object of `properties`. */
const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The descriptor of an object with no fields, and of null. */
const emptyObject = {
  descriptorVersion: 1,
  kind: "object",
  presence: "required",
  nullable: false,
  fields: {},
};
const nullValue = {
  descriptorVersion: 1,
  kind: "null",
  presence: "required",
  nullable: false,
};

/**
 * A workflow whose current version binds `crm` to HubSpot, as an admin
 * approved through the workflow's own permission on `connectionId`, and
 * declares `mail`, which no connection was approved for yet; with the
 * ID of `crm`'s approval.
 */
export const crmWorkflow = async (by: Admin, connectionId: string) => {
  const key = `crm-${unique()}`;
  const operation = {
    input: JSON.stringify(emptyObject),
    output: JSON.stringify(nullValue),
  };
  await publishCatalogContract(env, by.identity, {
    key,
    kind: "connector",
    operations: { HUBSPOT_LIST_CONTACTS: operation },
  });
  const workflow = await createWorkflowResource(
    env,
    by.identity,
    `crm-${unique()}`
  );
  const binding = (alias: string) => ({
    [alias]: { kind: "connector", contract: key },
  });
  await publishWorkflowVersion(env, by.identity, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: { ...binding("crm"), ...binding("mail") },
          },
        },
      },
      input: { schema: objectSchema({}) },
      output: { schema: objectSchema({ status: { type: "string" } }) },
      do: [
        ...["crm", "mail"].map((alias) => ({
          [alias]: {
            call: "grasp.connector",
            with: {
              binding: alias,
              operation: "HUBSPOT_LIST_CONTACTS",
              arguments: {},
            },
          },
        })),
        { finish: { set: { status: "done" } } },
      ],
    }),
    basedOn: null,
  });
  const asked = await requestPermission(
    env,
    by.identity,
    {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "connection", connectionId },
      actions: ["HUBSPOT_LIST_CONTACTS"],
      binding: `CRM_${unique().toUpperCase()}`,
    },
    {
      app: async () => await Promise.reject(new Error("No App here")),
      resource: async (ref, needed) => {
        await requireResourceRole(env, by.identity, ref, needed);
      },
    }
  );
  await grantPermission(env, by.identity, asked.id, { version: null });
  // What connect serves the connection as: HubSpot's tool, as Composio's
  // server would list it.
  const served: ConnectorContract = {
    contract: "composio.hubspot@1",
    actions: {
      HUBSPOT_LIST_CONTACTS: {
        tool: "HUBSPOT_LIST_CONTACTS",
        readOnly: false,
        input: JSON.stringify(
          jsonSchemaOf(schemaFromDescriptor(operation.input).descriptor, {
            exact: true,
          })
        ),
        output: JSON.stringify(
          jsonSchemaOf(schemaFromDescriptor(operation.output).descriptor, {
            exact: true,
          })
        ),
      },
    },
  };
  const connecting: Env = {
    ...env,
    CONNECT: new Proxy(env.CONNECT, {
      get: (target, name): unknown =>
        name === "connectorContract"
          ? async () => await Promise.resolve(served)
          : Reflect.get(target, name),
    }),
  };
  const approval = await approveWorkflowBinding(
    connecting,
    by.identity,
    workflow.id,
    {
      alias: "crm",
      target: {
        kind: "connector",
        permissionId: asked.id,
        contract: "composio.hubspot@1",
      },
      reviewed: { version: 1 },
    }
  );
  return { ...workflow, approval: approval.id };
};
