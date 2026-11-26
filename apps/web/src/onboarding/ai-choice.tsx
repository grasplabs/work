import { featuredModels } from "@grasp-os/shared/ai-providers";
import type {
  AiProviderModel,
  AiProvidersListing,
  OrganizationProviderId,
} from "@grasp-os/shared/ai-providers";
import { ConnectApiKey } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import type { ConnectApiKeyProvider } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { colors, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { failureMessage } from "../chat/failure.ts";
import { aiProviderLogos } from "../connections/brands.ts";
import { TopError } from "../frame/top-error.tsx";
import { useCoreAction } from "../use-core-action.ts";
import type { AiReadiness } from "./setup.ts";

// The AI step's one question: our own system (Grasp's AI, on Grasp's key,
// where this deployment offers it) or a key of the organization's own.
// Two radio rows, ours first and recommended, so an admin with no key and
// no idea what one is just presses Continue (Ruben: "so they are not
// getting stuck"). Choosing their own key opens Damsko's Connect API key
// block under the rows, which tests the key on Connect and says a refusal
// under it in the provider's words. The model is the provider's first
// featured one: choosing another is for Settings › AI providers.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4], width: "100%" },
  // The two ways as one list, as the connect step's permission answers stand, on a solid card:
  // the step's dither never shows through it (Ruben: "it shouldn't" be transparent).
  list: {
    display: "grid",
    backgroundColor: colors.card,
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  way: {
    paddingInline: space[3],
    paddingBlock: space[2],
    transitionProperty: "background-color",
    transitionDuration: "150ms",
  },
  between: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space[2],
    rowGap: space[1],
  },
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

/** The id of the key's form, which the step's Continue sends. */
export const aiKeyForm = "ai-key";

/** The step's two ways: our own system (Grasp's AI, on Grasp's key) or a key of their own. */
export type AiWay = "grasp" | "own";

/** The way to show chosen first: the one in use once a model answers, else ours where it's offered. */
export const firstWay = (ai: AiReadiness | null): AiWay => {
  if (ai === null) {
    return "own";
  }
  if (ai.ready) {
    return ai.listing.source;
  }
  return ai.listing.grasp.available ? "grasp" : "own";
};

/**
 * Our own system chosen in core: admin-only, audited, and refused where
 * this deployment has no key of Grasp's for it (ai-providers.ts setSource).
 * True once it's set and the page has read it again.
 */
export const useChooseGrasp = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const choose = async (): Promise<boolean> => {
    if (busy) {
      return false;
    }
    const set = await run(async (session) => {
      await session.aiProviders.setSource("grasp");
      return true;
    });
    if (set !== true) {
      return false;
    }
    await router.invalidate({ sync: true });
    return true;
  };
  return { busy, failure, choose };
};

/**
 * Which AI Grasp thinks with: our own system where this deployment offers
 * it, or a key of their own. The step's Continue takes our own; a key goes
 * in through the block, and `onReady` once a model answers.
 */
export const AiChoice = ({
  ai,
  way,
  onWay,
  onReady,
  onConnecting,
}: {
  ai: AiReadiness | null;
  way: AiWay;
  onWay: (way: AiWay) => void;
  onReady: () => void;
  /** While a key is tested: the step's Continue, which sent it, shows it. */
  onConnecting: (connecting: boolean) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { run } = useCoreAction();
  const listing = ai?.listing;
  const connect = useConnect(listing);
  // A refused key is said in the bar at the top, as every error in the setup is.
  const [refusal, setRefusal] = useState<string | null>(null);
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
  const keyBlock = (
    <>
      <TopError>{refusal}</TopError>
      <ConnectApiKey
        // Two and two: the four providers stand as a square, not three and one.
        // On the page, no card: the step's own title and line already say what the card's would.
        bare
        columns={2}
        connected={connected}
        // Sent by the step's own Continue in the foot, not a Connect of the block's.
        formId={aiKeyForm}
        labels={{
          change: t({ context: "button", message: "Change" }),
          connect: t`Connect`,
          connectName: (name) => t`Connect ${name}`,
          connected: t`Connected`,
          connecting: t`Connecting`,
          disconnect: t`Disconnect`,
          disconnectTitle: (name) => t`Disconnect ${name}?`,
          disconnecting: t`Disconnecting`,
          keep: t`Keep it`,
          key: t`Key`,
          keyLine: (last, region) =>
            region === undefined
              ? t`Key …${last}`
              : t`Key …${last} · ${region}`,
          keyMissing: t`Paste the key.`,
          keyNote: t`We store it sealed. You’ll only see its last four characters again.`,
          notConnected: t`Not connected`,
          notDisconnected: t`Couldn’t disconnect`,
          replaceKey: t`Replace key`,
        }}
        disconnectDetail={t`Grasp stops using it and its key is removed. You can choose another way right after.`}
        onConnect={async (choice) => {
          setRefusal(null);
          onConnecting(true);
          // The block says a refusal in the provider's words: thrown on, once Continue is free again.
          const failed = await connect(choice).then(
            () => null,
            (error: unknown) =>
              error instanceof Error ? error : new Error(String(error))
          );
          if (failed === null) {
            await router.invalidate({ sync: true });
          }
          onConnecting(false);
          if (failed !== null) {
            throw failed;
          }
          onReady();
        }}
        // Removed, they choose again: another provider, or our own system above.
        onDisconnect={async () => {
          if (own === undefined) {
            return;
          }
          const removed = await run(async (session) => {
            await session.aiProviders.remove(own.provider);
            return true;
          });
          if (removed !== true) {
            throw new Error(t`Couldn’t disconnect`);
          }
          await router.invalidate({ sync: true });
        }}
        onRefused={setRefusal}
        providers={providers}
        title={t`Your own key`}
      />
    </>
  );
  // Without ours on this deployment, a key is the one way: no choice to make.
  if (!listing.grasp.available) {
    return keyBlock;
  }
  const ways: {
    value: AiWay;
    label: string;
    description: string;
    recommended?: true;
  }[] = [
    {
      value: "grasp",
      label: t`Use our own system`,
      description: t`Ready right away, nothing to set up.`,
      recommended: true,
    },
    {
      value: "own",
      label: t`Use your own API key`,
      description: t`For a provider your company already works with. You pay them directly.`,
    },
  ];
  return (
    <div {...stylex.props(styles.stack)}>
      <RadioGroup
        aria-label={t`Which AI to use`}
        onValueChange={(value) => {
          if (value === "grasp" || value === "own") {
            onWay(value);
          }
        }}
        value={way}
      >
        <div {...stylex.props(styles.list)}>
          {ways.map(({ value, label, description, recommended }, index) => (
            <div
              key={value}
              {...stylex.props(styles.way, index > 0 && styles.between)}
            >
              <Field orientation="horizontal">
                <RadioGroupItem value={value} />
                <FieldContent>
                  <FieldLabel>
                    <span {...stylex.props(styles.head)}>
                      {label}
                      {recommended === true ? (
                        <Badge size="sm" variant="success">
                          {t`Recommended`}
                        </Badge>
                      ) : null}
                    </span>
                  </FieldLabel>
                  <FieldDescription>{description}</FieldDescription>
                </FieldContent>
              </Field>
            </div>
          ))}
        </div>
      </RadioGroup>
      {way === "own" ? keyBlock : null}
    </div>
  );
};
