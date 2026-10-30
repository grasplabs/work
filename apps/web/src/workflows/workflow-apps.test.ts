import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import type {
  WorkflowBindingApproval,
  WorkflowVersionBinding,
} from "@grasp-os/shared/workflow-resources";
import { describe, expect, it } from "vite-plus/test";

import { integrationsOf } from "../connections/integrations.ts";
import { workflowAppsOf } from "./workflow-apps.ts";

// The apps a workflow's Files and apps tab lists: only the apps whose
// connections serve this very workflow count as connected, and a binding
// of its current version that no approval for that version serves stays
// "not connected", whatever served an older version.

type Entry = OfferedCatalog["entries"][number];

const entry = (id: string, name: string): Entry => ({
  source: "native",
  id,
  name,
  categories: [],
  toolCount: 3,
  logo: null,
  description: null,
  group: "Other",
  auth: "managed",
  offered: true,
});

const connection = (id: string, provider: string): ListedConnection => ({
  id,
  source: "native",
  provider,
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: null,
  connectedByName: null,
  accountName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const binding = (
  alias: string,
  kind: WorkflowVersionBinding["kind"] = "connector"
): WorkflowVersionBinding => ({
  alias,
  kind,
  resourceId: null,
  resourceVersion: null,
  contractId: `crm/${alias}`,
  fingerprint: "f",
});

const approval = (
  alias: string,
  reviewedVersion: number,
  status: WorkflowBindingApproval["status"] = "active"
): WorkflowBindingApproval => ({
  id: crypto.randomUUID(),
  alias,
  kind: "connector",
  contractId: `crm/${alias}`,
  fingerprint: "f",
  target: {
    kind: "connector",
    permissionId: "perm",
    contract: "hubspot.crm@1",
  },
  reviewedVersion,
  status,
  approvedBy: "admin",
  approvedAt: "2026-10-01T00:00:00.000Z",
});

const integrations = integrationsOf(
  [entry("hubspot", "HubSpot"), entry("microsoft", "Microsoft 365")],
  [connection("c-hubspot", "hubspot"), connection("c-microsoft", "microsoft")]
);

describe(workflowAppsOf, () => {
  it("counts as connected only the apps whose connections serve this workflow", () => {
    const apps = workflowAppsOf({
      workflow: "w1",
      integrations,
      uses: [
        {
          connectionId: "c-hubspot",
          workflows: [{ kind: "independent", id: "w1", name: "invoices" }],
        },
        {
          connectionId: "c-microsoft",
          workflows: [{ kind: "independent", id: "w2", name: "other" }],
        },
      ],
      currentVersion: 2,
      bindings: [binding("crm")],
      approvals: [approval("crm", 2)],
    });
    expect(apps.connected.map(({ name }) => name)).toStrictEqual(["HubSpot"]);
    expect(apps.unconnected).toStrictEqual([]);
  });

  it("keeps a binding no approval for the current version serves as not connected", () => {
    const apps = workflowAppsOf({
      workflow: "w1",
      integrations,
      uses: [],
      currentVersion: 3,
      bindings: [
        binding("mail"),
        binding("crm"),
        binding("ledger"),
        binding("answer", "model"),
      ],
      approvals: [
        // Approved for an older version only.
        approval("crm", 2),
        // Revoked.
        approval("ledger", 3, "revoked"),
        approval("mail", 3),
      ],
    });
    expect(apps.connected).toStrictEqual([]);
    expect(apps.unconnected).toStrictEqual([
      { alias: "crm", contractId: "crm/crm" },
      { alias: "ledger", contractId: "crm/ledger" },
    ]);
  });
});
