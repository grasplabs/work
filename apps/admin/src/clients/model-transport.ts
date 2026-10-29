/**
 * A client's AI as its Setup shows it: how its core reaches its models
 * and where they run, read live from its core at
 * `modelTransportReportPath` (core's src/model-transport-report.ts),
 * signed as the spend report is (src/clients/quota-policy.ts), beside what
 * the admin sets (src/deploy/model-transport.ts). Where it runs is said
 * from the residency catalog's entries for the routes core reports;
 * computed from the configured transport only while core can't be asked,
 * and then said to be. Metadata only: never a prompt, an answer or a key.
 */
import {
  residencyCatalog,
  residencyEntryOf,
} from "@grasp-os/shared/model-residency";
import type { ResidencyEntry } from "@grasp-os/shared/model-residency";
import type {
  ModelTransport,
  ModelTransportConfig,
} from "@grasp-os/shared/model-transport";
import {
  modelTransportReportPath,
  modelTransportReportPurpose,
  modelTransportReportSchema,
} from "@grasp-os/shared/model-transport-report";
import type { ModelTransportReport } from "@grasp-os/shared/model-transport-report";
import { eq } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { clientTransportConfig } from "../deploy/model-transport.ts";
import type { ClientTransportConfig } from "../deploy/model-transport.ts";
import { healthTimeoutMs } from "./grid.ts";
import { askClientCore, signedCoreReport } from "./quota-policy.ts";

/** How long a probe may take: core gives its call 30 seconds. */
const probeTimeoutMs = 35_000;

/** A client's AI, as its Setup shows it. */
export interface ClientModelTransport {
  /** What the admin sets: its own setting, the transport its next deploy sets, its models. */
  configured: ClientTransportConfig;
  /** What its core reports; null when it couldn't be asked or didn't answer. */
  report: ModelTransportReport | null;
  /**
   * The residency catalog's entries for its routes: core's, or computed
   * from `configured` while `report` is null.
   */
  entries: ResidencyEntry[];
}

const entriesById: ReadonlyMap<string, ResidencyEntry> = new Map(
  residencyCatalog.map((entry) => [entry.id, entry])
);

/** The catalog's entries for the routes core reports, each once. */
const reportedEntries = (report: ModelTransportReport): ResidencyEntry[] => [
  ...new Set(
    report.routes.flatMap(({ route }) => {
      const entry = route === null ? undefined : entriesById.get(route);
      return entry === undefined ? [] : [entry];
    })
  ),
];

/** The catalog's entries `transport` reaches `models` by, each once. */
const transportEntries = (
  transport: ModelTransport,
  models: readonly string[]
): ResidencyEntry[] => {
  const providers = [
    ...new Set(models.map((model) => model.split("/")[0] ?? "")),
  ];
  if (transport.kind === "cloudflare-ai-gateway") {
    return providers.flatMap((provider) => {
      const entry = residencyEntryOf({
        transport: transport.kind,
        provider,
        host: "workers-binding.ai",
      });
      return entry === undefined ? [] : [entry];
    });
  }
  if (transport.kind === "direct") {
    return (["anthropic", "openai", "bedrock-eu"] as const).flatMap(
      (provider) => {
        const entry =
          transport[provider] === undefined
            ? undefined
            : entriesById.get(`direct/${provider}`);
        return entry === undefined ? [] : [entry];
      }
    );
  }
  if (transport.kind === "openrouter") {
    const entry = entriesById.get("openrouter/*");
    return entry === undefined ? [] : [entry];
  }
  const entry = residencyEntryOf({
    transport: transport.kind,
    provider: "*",
    host: URL.parse(transport.baseUrl)?.hostname ?? "",
  });
  return entry === undefined ? [] : [entry];
};

/**
 * The catalog's entries the configured transport and failover reach the
 * allowed models by, each once: what Setup says while core can't be asked.
 */
export const configuredEntries = (
  config: Pick<ModelTransportConfig, "primary" | "failover">,
  models: readonly string[]
): ResidencyEntry[] => [
  ...new Map(
    [config.primary, ...config.failover]
      .flatMap((transport) => transportEntries(transport, models))
      .map((entry) => [entry.id, entry])
  ).values(),
];

/** Active client `clientId`'s core's report, a probe made when `probe`; null when unknown. */
const reportOf = async (
  env: Env,
  clientId: string,
  probe: { staff: string } | null
): Promise<ModelTransportReport | null> =>
  await askClientCore(
    env,
    clientId,
    "model_transport",
    async (request) =>
      await signedCoreReport(request, {
        path: modelTransportReportPath,
        purpose: modelTransportReportPurpose,
        schema: modelTransportReportSchema,
        body: probe === null ? {} : { probe: true, staff: probe.staff },
      }),
    probe === null ? healthTimeoutMs : probeTimeoutMs
  );

/**
 * Client `clientId`'s AI, its core asked when it's active (with a probe
 * call when `probe` names who asks for one); null when there's no such
 * client. Never throws for its core: one that can't be asked or doesn't
 * answer leaves the report null.
 */
export const clientModelTransport = async (
  env: Env,
  clientId: string,
  probe: Staff | null = null
): Promise<ClientModelTransport | null> => {
  const db = adminDatabase(env.DB);
  const client = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    return null;
  }
  const configured = await clientTransportConfig(db, clientId);
  const report =
    client.status === "active"
      ? await reportOf(
          env,
          clientId,
          probe === null ? null : { staff: probe.email }
        )
      : null;
  return {
    configured,
    report,
    entries:
      report === null
        ? configuredEntries(configured.effective.config, configured.models)
        : reportedEntries(report),
  };
};
