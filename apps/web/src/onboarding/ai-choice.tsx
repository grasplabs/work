import { featuredModels } from "@grasp-os/shared/ai-providers";
import type {
  AiProviderModel,
  AiProvidersListing,
  OrganizationProviderId,
} from "@grasp-os/shared/ai-providers";
import { ConnectApiKey } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import type { ConnectApiKeyProvider } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";

import { failureMessage } from "../chat/failure.ts";
import { aiProviderLogos } from "../connections/brands.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import type { AiReadiness } from "./setup.ts";

// The AI step's one question: Grasp's AI, where this deployment offers
// it, or a key of the organization's own, on Damsko's Connect API key
// block. Grasp's AI is one row above the block, pressed to choose it (it
// takes no key, so it is no tile of the block's); a key goes in through
// the block, which tests it on Connect and says a refusal under it in the
// provider's words. The model is the provider's first featured one:
// choosing another is for Settings › AI providers.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4], width: "100%" },
});

type Offered = AiProvidersListing["offered"][number];

/** The model to start on: the provider's first featured one, else its first. */
const firstModel = (
  offered: Pick<Offered, "provider" | "models">
): AiProviderModel | undefined => {
  const featured = featuredModels[offered.provider].find((model) =>
    offered.models.some((each) => each.model === model)
  );
  return (
    offered.models.find((each) => each.model === featured) ?? offered.models[0]
  );
};

/** An endpoint of the organization's own names its model, which the block does not ask for. */
const keyed = (provider: OrganizationProviderId) =>
  provider !== "openai-compatible";

/** Where it runs, from the provider's own words ("Mistral AI, European Union (France)"). */
const regionOf = (whereItRuns: string): string | undefined => {
  const [, region] = whereItRuns.split(", ");
  return region;
};

/** The key goes to core, the model answers one tiny question, and is chosen once it has. */
const useConnect = (listing: AiProvidersListing | undefined) => {
  const { t, i18n } = useLingui();
  const { run } = useCoreAction();
  return async ({
    provider: id,
    key,
  }: {
    provider: string;
    key: string;
  }): Promise<void> => {
    const offered = listing?.offered.find((each) => each.provider === id);
    if (offered === undefined || !keyed(offered.provider)) {
      throw new Error(t`Choose a provider.`);
    }
    const { provider, label } = offered;
    const model = firstModel(offered)?.model;
    if (model === undefined) {
      throw new Error(t`This provider has no model to offer yet.`);
    }
    let failure: string | undefined;
    const tested = await run(
      async (session) => {
        await session.aiProviders.add({ provider, key });
        const answer = await session.aiProviders.test(provider, model);
        await (answer.ok
          ? session.aiProviders.setModels({ defaultModel: model })
          : session.aiProviders.remove(provider));
        if (answer.ok && listing?.source === "grasp") {
          await session.aiProviders.setSource("own");
        }
        return answer;
      },
      (reason) => {
        failure = reason;
      }
    );
    if (tested === undefined) {
      throw new Error(failure ?? t`That didn’t go through. Try again.`);
    }
    if (!tested.ok) {
      throw new Error(
        tested.code === "model.provider_key_failed"
          ? t`${label} refused that key. Check it in your provider’s console and paste it again.`
          : failureMessage(tested.code, i18n)
      );
    }
  };
};

/** Grasp's AI as one row, pressed to choose it; marked once it is the one in use. */
const GraspRow = ({
  inUse,
  onChosen,
}: {
  inUse: boolean;
  onChosen: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const choose = async () => {
    if (busy) {
      return;
    }
    const set = await run(async (session) => {
      await session.aiProviders.setSource("grasp");
      return true;
    });
    if (set === true) {
      await router.invalidate({ sync: true });
      onChosen();
    }
  };
  return (
    <>
      <Item
        active={inUse}
        onClick={() => {
          void choose();
        }}
        variant="outline"
      >
        <ItemContent>
          <ItemTitle>{t`Use Grasp’s AI`}</ItemTitle>
        </ItemContent>
        {inUse ? (
          <ItemActions>
            <Icon icon={CheckIcon} label={t`In use`} />
          </ItemActions>
        ) : null}
      </Item>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/**
 * Which AI Grasp thinks with: Grasp's AI where this deployment offers it,
 * or a key of their own. `onReady` once a model answers.
 */
export const AiChoice = ({
  ai,
  onReady,
}: {
  ai: AiReadiness | null;
  onReady: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const listing = ai?.listing;
  const connect = useConnect(listing);
  if (listing === undefined) {
    return null;
  }
  const providers: ConnectApiKeyProvider[] = listing.offered
    .filter((each) => keyed(each.provider))
    .map((each) => {
      const region = regionOf(each.whereItRuns);
      const logo = aiProviderLogos[each.provider];
      return {
        id: each.provider,
        name: each.label,
        ...(logo === undefined ? {} : { logo }),
        ...(region === undefined
          ? {}
          : { region: { icon: null, label: region } }),
      };
    });
  const ready = ai?.ready === true;
  const own = listing.source === "own" ? listing.providers[0] : undefined;
  const connected =
    ready && own !== undefined
      ? { provider: own.provider, last: own.mask.replace("…", "") }
      : null;
  return (
    <div {...stylex.props(styles.stack)}>
      {listing.grasp.available ? (
        <GraspRow
          inUse={ready && listing.source === "grasp"}
          onChosen={onReady}
        />
      ) : null}
      <ConnectApiKey
        // Two and two: the four providers stand as a square, not three and one.
        // On the page, no card: the step's own title and line already say what the card's would.
        bare
        columns={2}
        connected={connected}
        labels={{
          keyNote: t`We store it sealed. You’ll only see its last four characters again.`,
        }}
        onConnect={async (choice) => {
          await connect(choice);
          await router.invalidate({ sync: true });
          onReady();
        }}
        providers={providers}
        title={t`Your own key`}
      />
    </div>
  );
};
