import type {
  AiProvidersListing,
  OrganizationProviderId,
} from "@grasp-os/shared/ai-providers";
import { ConnectApiKey } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import type { ConnectApiKeyProvider } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";

import { failureMessage } from "../../chat/failure.ts";
import { GraspLogo } from "../../connections/brand-logos.ts";
import { ErrorText } from "../../error-text.tsx";
import { useCoreAction } from "../../use-core-action.ts";
import { modelsToOffer } from "../ai-step.tsx";
import type { AiReadiness } from "../setup.ts";

// The AI step's one question for every concept: Grasp's AI, or a key of the
// organization's own, on Damsko's Connect API key block. Grasp's AI is one
// row above the block (it takes no key, so it is no tile of the block's);
// a key goes in through the block, which tests it on Connect and says a
// refusal under it in the provider's words. The model is the provider's
// first featured one: choosing another is for Settings › AI providers.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4], width: "100%" },
});

/** An endpoint of the organization's own names its model, which the block does not ask for. */
const keyed = (provider: OrganizationProviderId) =>
  provider !== "openai-compatible";

/** Where it runs, from the provider's own words ("Mistral AI, European Union (France)"). */
const regionOf = (whereItRuns: string): string | undefined => {
  const [, region] = whereItRuns.split(", ");
  return region;
};

/** The key goes to core, the model answers one tiny question, and is chosen once it has. */
const useConnect = (listing: AiProvidersListing) => {
  const { t, i18n } = useLingui();
  const { run } = useCoreAction();
  return async ({
    provider: id,
    key,
  }: {
    provider: string;
    key: string;
  }): Promise<void> => {
    const offered = listing.offered.find((each) => each.provider === id);
    if (offered === undefined || !keyed(offered.provider)) {
      throw new Error(t`Choose a provider.`);
    }
    const { provider } = offered;
    const model = modelsToOffer(offered, false)[0]?.model;
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
        if (answer.ok && listing.source === "grasp") {
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
          ? t`${offered.label} refused that key. Check it in your provider’s console and paste it again.`
          : failureMessage(tested.code, i18n)
      );
    }
  };
};

/** Grasp's AI as one row: what it runs on, and the way to choose it. */
const GraspRow = ({
  listing,
  inUse,
  onChosen,
}: {
  listing: AiProvidersListing;
  inUse: boolean;
  onChosen: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const model = listing.grasp.model.name;
  const choose = async () => {
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
      <Item variant="outline">
        <ItemMedia variant="icon">
          <Icon icon={GraspLogo} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t`Grasp’s AI`}</ItemTitle>
          <ItemDescription>{t`Nothing to set up. Runs on ${model} in the EU, and you pay for what you use.`}</ItemDescription>
        </ItemContent>
        <ItemActions>
          {inUse ? (
            <Badge variant="success">{t`In use`}</Badge>
          ) : (
            <Button
              onClick={() => {
                void choose();
              }}
              size="sm"
              status={busy ? "loading" : "idle"}
              variant="outline"
            >
              {t`Use Grasp’s AI`}
            </Button>
          )}
        </ItemActions>
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
  const connect = useConnect(
    listing ?? {
      source: "own",
      grasp: {
        available: false,
        model: { model: "", name: "" },
        whereItRuns: "",
        month: { spentUsd: 0, limitUsd: 0, reached: false },
      },
      providers: [],
      offered: [],
      choice: null,
      platform: [],
    }
  );
  if (listing === undefined) {
    return null;
  }
  const providers: ConnectApiKeyProvider[] = listing.offered
    .filter((each) => keyed(each.provider))
    .map((each) => {
      const region = regionOf(each.whereItRuns);
      return {
        id: each.provider,
        name: each.label,
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
          listing={listing}
          onChosen={onReady}
        />
      ) : null}
      <ConnectApiKey
        connected={connected}
        description={
          listing.grasp.available
            ? t`Or use your own contract with a provider. You pay them directly.`
            : t`Your own contract with a provider. You pay them directly.`
        }
        labels={{
          keyNote: t`Stored sealed. Only its last four characters are shown again.`,
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
