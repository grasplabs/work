import {
  euModelTransport,
  defaultModelTransport,
  modelResidencies,
} from "@grasp-os/shared/model-transport";
import type { ModelResidency } from "@grasp-os/shared/model-transport";
import { createFileRoute, useRouter } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";
import {
  fetchPlatformTransports,
  setPlatformModelTransportFn,
} from "../../admin/platform-ai.ts";
import type { PlatformTransportErrorCode } from "../../admin/platform-ai.ts";
import { PlatformNav, platformCrumb } from "../../admin/platform-nav.tsx";
import { Body, SetupSection } from "../../admin/setup-parts.tsx";
import { TransportForm } from "../../admin/transport-form.tsx";
import type { TransportChoice } from "../../admin/transport-form.tsx";
import { transportWords } from "../../admin/transport-words.ts";
import type { PlatformTransport } from "../../deploy/model-transport.ts";
import { thenRefresh, useAction } from "../../use-action.ts";

/** What staff read when the admin refuses a default, by its code. */
const refusals: Readonly<Record<PlatformTransportErrorCode, string>> = {
  model_transport_invalid:
    "That isn't a way to reach models: check each field, such as the endpoint's URL and its models.",
  attestation_not_yours:
    "You can only attest an endpoint yourself: tick the box and give the basis as you.",
  changed_meanwhile:
    "Someone else changed it at the same moment: the page shows it as it is now, so look and save again.",
};

/** Each residency's default, as a section names it. */
const titles: Readonly<Record<ModelResidency, string>> = {
  eu: "EU organizations",
  global: "Organizations whose AI may run anywhere",
};

/** The built-in default each residency falls back to. */
const builtIn: Readonly<Record<ModelResidency, string>> = {
  eu: transportWords(euModelTransport.primary),
  global: transportWords(defaultModelTransport.primary),
};

/** One residency's default: what it is, and changing it. */
const Default = ({
  residency,
  transport,
}: {
  residency: ModelResidency;
  transport: PlatformTransport | null;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  const save = (choice: TransportChoice | null) => {
    void run(
      async () =>
        await thenRefresh(
          async () =>
            await setPlatformModelTransportFn({
              data: {
                residency,
                transport:
                  choice === null
                    ? null
                    : { primary: choice.primary, failover: choice.failover },
              },
            }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  const failover =
    transport === null || transport.failover.length === 0
      ? ""
      : ` Fails over to ${transport.failover.map(transportWords).join(", then ")}.`;
  return (
    <SetupSection
      description="Every client of these without a transport of its own takes it with its next deploy. Its core still keeps each call within the client's hosting policy."
      title={titles[residency]}
    >
      <Body>
        <p>
          {transport === null
            ? `The built-in default: ${builtIn[residency]}.`
            : `${transportWords(transport.primary)}.${failover}`}
        </p>
        <TransportForm
          busy={busy}
          current={transport}
          defaultWords={`The built-in default (${builtIn[residency]})`}
          euOnly={false}
          failure={failure}
          id={`platform-${residency}`}
          // Keyed by what's saved: it starts again from it after each change.
          key={JSON.stringify(transport)}
          offerEuOnly={false}
          onSave={save}
        />
      </Body>
    </SetupSection>
  );
};

/**
 * Platform's AI page: the way clients reach their models by default, one
 * for each residency a hosting policy may need (src/admin/platform-ai.ts),
 * each change audited.
 */
const AiPage = () => {
  const transports = Route.useLoaderData();
  return (
    <AdminPage
      description="How clients reach their models until staff set a way of their own. Keys are named here; their values are in MODEL_PROVIDER_KEYS in Secrets Store."
      parents={[platformCrumb]}
      title="AI"
    >
      <PlatformNav />
      <div className="flex flex-col gap-6">
        {modelResidencies.map((residency) => (
          <Default
            key={residency}
            residency={residency}
            transport={transports[residency]}
          />
        ))}
      </div>
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/ai")({
  loader: async () => await fetchPlatformTransports(),
  head: () => ({ meta: [{ title: "AI" }] }),
  component: AiPage,
});
