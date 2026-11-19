import type { OrganizationProviderId } from "@grasp-os/shared/ai-providers";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Backdrop } from "../grasp/backdrop/index.ts";
import type { BackdropLook } from "../grasp/backdrop/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import { Form, FormActions } from "../grasp/form/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { ArrowLeft, ArrowRight, Cable } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Link } from "../grasp/link/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Stepper } from "../grasp/stepper/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../grasp/tooltip/index.ts";
import {
  AddProviderDialog,
  AddressField,
  KeyField,
  Mark,
  WhereItRuns,
  marks,
  providerName,
  reasonOf,
} from "./ai-providers.tsx";
import type { Connect, ConnectCardProps } from "./ai-providers.tsx";

// Three concepts, for Ruben to choose one, of what Settings › AI and spend
// shows while no AI provider is connected: on this branch alone, never
// merged, switched by `?concept=a|b|c` on the page. Each connects for
// real, through the page's own `connect`: the key is added, then tested,
// and kept only once it works; the page then turns into the connected row.
//
//   a: the card is the connection, providers as tiles, the key in the card
//   b: a painted welcome, one action, the existing dialog
//   c: three short steps in the card, Choose, Paste your key, Test and connect

/** Which concept, as the route reads it. */
export type Concept = "a" | "b" | "c";

export const concepts: readonly Concept[] = ["a", "b", "c"];

/**
 * Where each provider's keys are made, for the step that asks for one;
 * none for a custom endpoint, whose keys are the organization's own.
 */
const keyPages: Readonly<Record<OrganizationProviderId, string | undefined>> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  mistral: "https://console.mistral.ai/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
  "openai-compatible": undefined,
};

/** B's ground: the library's dither, in the house's mint. */
const welcomeLook: BackdropLook = {
  backdrop: "dusk",
  pattern: "bayer",
  tone: "mint",
};

const styles = stylex.create({
  stack: { display: "grid", gap: grasp.space4, minWidth: 0 },
  tiles: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
    gap: grasp.space2,
  },
  // B: the dither fills the card, clipped to its corners; the words stand
  // centred on it.
  clip: {
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    overflow: "hidden",
  },
  welcome: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space4,
    paddingBlock: grasp.space12,
    paddingInline: grasp.space6,
  },
  words: {
    display: "grid",
    justifyItems: "center",
    gap: grasp.space2,
    maxWidth: "28rem",
    textAlign: "center",
  },
  marks: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: grasp.space1,
  },
});

/** Connecting: working while the key is added and tested, then connected, or why not. */
const useConnect = (run: () => Promise<void>) => {
  const { t } = useLingui();
  return useAction(run, {
    working: t`Connecting`,
    done: t`Connected`,
    failed: t`Not connected`,
  });
};

/** A provider's mark at a tile's size: its brand's tile, or a plug for a custom endpoint. */
const TileMark = ({ provider }: { provider: OrganizationProviderId }) => {
  const brand = marks[provider];
  return brand === undefined ? (
    <ItemMedia icon={Cable} />
  ) : (
    <ItemMedia>
      <BrandIcon brand={brand} decorative size="md" />
    </ItemMedia>
  );
};

/** The providers as tiles, each its mark, its name and where it runs; a press chooses it. */
const ProviderTiles = ({
  offered,
  onChoose,
}: {
  offered: ConnectCardProps["offered"];
  onChoose: (provider: OrganizationProviderId) => void;
}) => (
  <div {...stylex.props(styles.tiles)}>
    {offered.map((each) => {
      const label = providerName(each.provider, each.label);
      return (
        <Item
          key={each.provider}
          render={
            <button
              aria-label={label}
              onClick={() => {
                onChoose(each.provider);
              }}
              type="button"
            />
          }
          variant="outline"
        >
          <TileMark provider={each.provider} />
          <ItemContent>
            <ItemTitle>{label}</ItemTitle>
            <ItemDescription>
              <WhereItRuns provider={each.provider} />
            </ItemDescription>
          </ItemContent>
        </Item>
      );
    })}
  </div>
);

// ---- A: the card is the connection ---------------------------------------

/** A's key, in the card: the provider chosen, its key, and Connect. */
const KeyInCard = ({
  provider,
  label,
  connect,
  onBack,
}: {
  provider: OrganizationProviderId;
  label: string;
  connect: Connect;
  onBack: () => void;
}) => {
  const { t } = useLingui();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const connecting = useConnect(async () => {
    await connect(provider, key, baseUrl);
  });
  return (
    <Form
      aria-label={t`Connect ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        void connecting.run();
      }}
    >
      <Item variant="outline">
        <TileMark provider={provider} />
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
          <ItemDescription>
            <WhereItRuns provider={provider} />
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            disabled={connecting.state === "working"}
            onClick={onBack}
            size="sm"
            variant="ghost"
          >
            {t`Change`}
          </Button>
        </ItemActions>
      </Item>
      {provider === "openai-compatible" ? (
        <AddressField onValueChange={setBaseUrl} value={baseUrl} />
      ) : null}
      <KeyField onValueChange={setKey} provider={provider} value={key} />
      {connecting.error === null || connecting.error === undefined ? null : (
        <Alert tone="danger">{reasonOf(connecting.error)}</Alert>
      )}
      <FormActions>
        <Button type="submit" variant="ink" {...connecting.status}>
          {t`Connect`}
        </Button>
      </FormActions>
    </Form>
  );
};

/** A: one line of what it unlocks, the providers as tiles; a tile opens its key here. */
const ConceptA = ({ offered, connect }: ConnectCardProps) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<OrganizationProviderId>();
  const provider = offered.find((each) => each.provider === chosen);
  return (
    <SectionCard variant="grouped" density="compact" title={t`Providers`}>
      {provider === undefined ? (
        <div {...stylex.props(styles.stack)}>
          <Heading level={3} size="sm">
            {t`Choose the AI that Grasp's chat, agents and workflows run on.`}
          </Heading>
          <ProviderTiles offered={offered} onChoose={setChosen} />
        </div>
      ) : (
        <KeyInCard
          connect={connect}
          // A new choice is a new form: no key typed for another stays.
          key={provider.provider}
          label={providerName(provider.provider, provider.label)}
          onBack={() => {
            setChosen(undefined);
          }}
          provider={provider.provider}
        />
      )}
    </SectionCard>
  );
};

// ---- B: a painted welcome ------------------------------------------------

/** B: the dither behind a title and one sentence, one action, the marks under it; each opens the dialog. */
const ConceptB = ({ offered, connect }: ConnectCardProps) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<OrganizationProviderId>();
  const openWith = (provider?: OrganizationProviderId): void => {
    setChosen(provider);
    setOpen(true);
  };
  return (
    <SectionCard variant="grouped" density="compact" flush title={t`Providers`}>
      <div {...stylex.props(styles.clip)}>
        <Backdrop layout={styles.welcome} variant={welcomeLook}>
          <div {...stylex.props(styles.words)}>
            <Heading level={3} size="md">
              {t`Your AI, on your own key`}
            </Heading>
            <Text size="sm" tone="muted">
              {t`Grasp's chat, agents and workflows run on the AI provider you connect, billed to your own account.`}
            </Text>
          </div>
          <Button
            onClick={() => {
              openWith();
            }}
            variant="ink"
          >
            {t`Connect a provider`}
          </Button>
          <div {...stylex.props(styles.marks)}>
            {offered.map((each) => {
              const label = providerName(each.provider, each.label);
              return (
                <Tooltip key={each.provider}>
                  <TooltipTrigger
                    aria-label={label}
                    onClick={() => {
                      openWith(each.provider);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <Mark provider={each.provider} />
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </Backdrop>
      </div>
      <AddProviderDialog
        chosen={chosen}
        offered={offered}
        onAdd={connect}
        onChoose={setChosen}
        onOpenChange={setOpen}
        open={open}
      />
    </SectionCard>
  );
};

// ---- C: three short steps in the card ------------------------------------

/** C: Choose, Paste your key, Test and connect: one step a screen, Back and Next; a tile is Next on the first. */
const ConceptC = ({ offered, connect }: ConnectCardProps) => {
  const { t } = useLingui();
  const [step, setStep] = useState(0);
  const [chosen, setChosen] = useState<OrganizationProviderId>();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const provider =
    offered.find((each) => each.provider === chosen) ?? offered[0];
  const connecting = useConnect(async () => {
    if (provider !== undefined) {
      await connect(provider.provider, key, baseUrl);
    }
  });
  if (provider === undefined) {
    return null;
  }
  const label = providerName(provider.provider, provider.label);
  const keyPage = keyPages[provider.provider];
  const failed =
    connecting.error !== null && connecting.error !== undefined && step === 2;
  const back = (
    <Button
      disabled={connecting.state === "working"}
      icon={ArrowLeft}
      onClick={() => {
        setStep(step - 1);
      }}
    >
      {t`Back`}
    </Button>
  );
  const next = (
    <Button iconEnd={ArrowRight} type="submit" variant="ink">
      {t`Next`}
    </Button>
  );
  return (
    <SectionCard variant="grouped" density="compact" title={t`Providers`}>
      <div {...stylex.props(styles.stack)}>
        <Stepper
          aria-label={t`Steps`}
          onValueChange={setStep}
          steps={[
            { label: t`Choose` },
            { label: t`Paste your key` },
            {
              label: t`Test and connect`,
              ...(failed ? { state: "failed" as const } : {}),
            },
          ]}
          value={step}
        />
        {step === 0 ? (
          <ProviderTiles
            offered={offered}
            onChoose={(each) => {
              // Another provider's key is not this one's.
              if (each !== provider.provider) {
                setKey("");
                setBaseUrl("");
              }
              setChosen(each);
              setStep(1);
            }}
          />
        ) : null}
        {step === 1 ? (
          <Form
            aria-label={t`Paste your key`}
            onSubmit={(event) => {
              event.preventDefault();
              setStep(2);
            }}
          >
            {provider.provider === "openai-compatible" ? (
              <AddressField onValueChange={setBaseUrl} value={baseUrl} />
            ) : null}
            <KeyField
              onValueChange={setKey}
              provider={provider.provider}
              value={key}
            />
            {keyPage === undefined ? null : (
              <Link external href={keyPage} variant="standalone">
                {t`Create a key at ${label}`}
              </Link>
            )}
            <FormActions>
              {back}
              {next}
            </FormActions>
          </Form>
        ) : null}
        {step === 2 ? (
          <div {...stylex.props(styles.stack)}>
            <Item variant="outline">
              <TileMark provider={provider.provider} />
              <ItemContent>
                <ItemTitle>
                  {label}
                  <ItemDetail>{`•••• ${key.slice(-4)}`}</ItemDetail>
                </ItemTitle>
                <ItemDescription>
                  <WhereItRuns provider={provider.provider} />
                </ItemDescription>
              </ItemContent>
            </Item>
            {failed ? (
              <Alert tone="danger">{reasonOf(connecting.error)}</Alert>
            ) : null}
            <FormActions>
              {back}
              <Button
                onClick={() => {
                  void connecting.run();
                }}
                variant="ink"
                {...connecting.status}
              >
                {t`Test and connect`}
              </Button>
            </FormActions>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
};

/** The card to connect the first provider, as concept `concept` draws it. */
export const ConnectConcept = ({
  concept,
  ...props
}: ConnectCardProps & { concept: Concept }) => {
  if (concept === "a") {
    return <ConceptA {...props} />;
  }
  return concept === "b" ? <ConceptB {...props} /> : <ConceptC {...props} />;
};
