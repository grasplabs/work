import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import type { ContextWords } from "@grasp-os/shared/onboarding-context";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemContent,
  ItemGrid,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { FileIcon, Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { canConnect, ConnectDialog } from "../connections/connect-dialog.tsx";
import { integrationsOf, stateOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import { formatList } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";
import { isLocale } from "../i18n.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
import { useConnectionReturn } from "./connection-return.ts";
import { ConnectorSearch } from "./connector-search.tsx";
import { sourcesFor } from "./setup.ts";
import type { DocumentSource } from "./setup.ts";
import { namedPlaces, sourceLogo } from "./source-logos.ts";
import type { SetupData, StepProps } from "./step-parts.ts";
import { SupportLink } from "./support-link.tsx";

// Where the documents live: the places, those of the company's sign-in
// and those the kickoff named first, each a tile pressed to note it; where
// Grasp connects it through Integrations, its sign-in follows in the
// connect dialog. "Something else" opens a search over every app Grasp
// connects through Integrations; one picked there is noted by name and,
// where it can be, connected; a name the catalog lacks is asked for. Each
// choice goes to core, which counts it in how much Grasp knows. The places
// stand as tiles, three in a row, each with its own logo, whole, in its
// own colours.

const styles = stylex.create({
  stack: { display: "grid", gap: space[3] },
  // A logo whole, at the tile's size, never cut to a rounded square: Notion's corners went missing so.
  logo: {
    display: "block",
    width: size.controlDefault,
    height: size.controlDefault,
    objectFit: "contain",
  },
});

/** A place's logo, whole, on the middle of its tile. */
export const Logo = ({ src }: { src: string }) => (
  <ItemMedia align="center">
    <img alt="" src={src} {...stylex.props(styles.logo)} />
  </ItemMedia>
);

/** Keeps what the admin chose, and reads core again so every step shows it. */
export const useSaveChoices = () => {
  const router = useRouter();
  const { run, busy, failure } = useCoreAction();
  const save = async (next: SetupChoices): Promise<boolean> => {
    const kept = await run(
      async (session) => await session.onboarding.saveChoices(next)
    );
    if (kept === undefined) {
      return false;
    }
    await router.invalidate({ sync: true });
    return true;
  };
  return { save, busy, failure };
};

/** The integrations last read while this page is open: coming back, what is connected shows at once. */
let lastRead: Integration[] = [];

/** The integrations Grasp offers here, with what is connected: the ones last read, or none, while they load. */
export const useIntegrations = (): Integration[] => {
  const core = useCore();
  const [integrations, setIntegrations] = useState<Integration[]>(lastRead);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) =>
          await Promise.all([
            session.connections.catalog(),
            session.connections.list(),
          ]),
        left.signal
      );
      if (!left.signal.aborted && loaded.state === "ready") {
        const [catalog, connections] = loaded.data;
        lastRead = integrationsOf(catalog.entries, connections);
        setIntegrations(lastRead);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return integrations;
};

/** Where the setup goes back to once a connection's sign-in is done. */
const sourcesReturn = "/setup?step=sources";

/** What the kickoff told about the company, in the language the page is in. */
export const useContextWords = (data: SetupData): ContextWords | undefined => {
  const { i18n } = useLingui();
  return data.view.context.words[isLocale(i18n.locale) ? i18n.locale : "en"];
};

/** The kinds of documents the company's work runs on, as a list that starts a sentence; null where the kickoff named none. */
export const kindsOf = (words: ContextWords | undefined): string | null => {
  const kinds = words?.documents ?? [];
  if (kinds.length === 0) {
    return null;
  }
  const list = formatList(kinds);
  return `${list.charAt(0).toLocaleUpperCase()}${list.slice(1)}`;
};

export const SourcesStep = ({ data, onward }: StepProps) => {
  const { t } = useLingui();
  const { choices, signIn, identity } = data;
  const { save, busy, failure } = useSaveChoices();
  // An app's sign-in that came back without connecting: said over the step, with the way on.
  const returned = useConnectionReturn();
  const [returnClosed, setReturnClosed] = useState(false);
  const integrations = useIntegrations();
  const [connecting, setConnecting] = useState<Integration | null>(null);
  const [searching, setSearching] = useState(false);
  const kinds = kindsOf(useContextWords(data));
  const noted = choices.sources;
  const listed = sourcesFor(signIn, data.view.context, noted);
  const wanted = choices.sourcesWanted;
  const integrationOf = (source: DocumentSource) =>
    integrations.find(
      ({ source: kind, id }) =>
        kind === source.integration.source && id === source.integration.id
    );
  const isConnected = (source: DocumentSource): boolean => {
    const integration = integrationOf(source);
    if (integration === undefined) {
      return false;
    }
    const state = stateOf(integration);
    return state === "shared" || state === "personal";
  };
  // A suite's places connect only through the company's own sign-in.
  const connectable = (source: DocumentSource): Integration | undefined => {
    const integration = integrationOf(source);
    if (
      integration === undefined ||
      isConnected(source) ||
      (source.suite !== null && !signIn.includes(source.suite)) ||
      !canConnect(integration, identity)
    ) {
      return undefined;
    }
    return integration;
  };
  const press = async (source: DocumentSource) => {
    if (busy) {
      return;
    }
    const kept =
      noted.includes(source.id) ||
      (await save({ ...choices, sources: [...noted, source.id] }));
    if (kept) {
      setConnecting(connectable(source) ?? null);
    }
  };
  const isAsked = (name: string): boolean =>
    wanted.some((each) => each.toLowerCase() === name.toLowerCase());
  const ask = async (name: string) => {
    if (!isAsked(name)) {
      await save({ ...choices, sourcesWanted: [...wanted, name] });
    }
  };
  // A named place pressed again is no longer asked for.
  const toggleAsked = async (name: string) => {
    if (busy) {
      return;
    }
    if (isAsked(name)) {
      await save({
        ...choices,
        sourcesWanted: wanted.filter(
          (each) => each.toLowerCase() !== name.toLowerCase()
        ),
      });
      return;
    }
    await ask(name);
  };
  // Asked for by name beyond the places offered as tiles.
  const typed = wanted.filter(
    (each) =>
      !namedPlaces.some(({ name }) => name.toLowerCase() === each.toLowerCase())
  );
  // An app asked for by name that the catalog holds: its logo, and its sign-in where it connects.
  const integrationNamed = (name: string): Integration | undefined =>
    integrations.find(
      (each) => each.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
  const connectableNamed = (name: string): Integration | undefined => {
    const integration = integrationNamed(name);
    return integration === undefined ||
      stateOf(integration) === "shared" ||
      stateOf(integration) === "personal" ||
      !canConnect(integration, identity)
      ? undefined
      : integration;
  };
  // What became of a place, said to a screen reader after its name; its tile glows with it.
  const stateOfRow = (source: DocumentSource): string | null => {
    if (!noted.includes(source.id)) {
      return null;
    }
    return isConnected(source) ? t`connected` : t`noted`;
  };
  return (
    <CalmStep
      body={
        kinds === null
          ? t`The files, pages and folders your team works from. Connect the tools they’re in, and I’ll only read what you share with me.`
          : t`${kinds}. Connect where they live, and I’ll only read what you share with me.`
      }
      also={
        <SupportLink page="documents">{t`More about these connections`}</SupportLink>
      }
      end={
        <Button
          onClick={() => {
            void onward();
          }}
          size="lg"
        >
          {t`Continue`}
        </Button>
      }
      spoken={t`Next, I’d like to understand how the work actually gets done. Most of it lives in the tools your team already uses: shared drives, Teams channels and wikis, full of the files and pages people work from every day. Point me to the ones you use, and I’ll only read what you choose to share with me.`}
      title={t`Where does the work get written down?`}
    >
      <div {...stylex.props(styles.stack)}>
        <ItemGrid aria-label={t`Where your documents live`} columns={3}>
          {listed.map((source) => {
            const state = stateOfRow(source);
            const done = noted.includes(source.id) && isConnected(source);
            const logo = sourceLogo(source);
            return (
              <Item
                done={state !== null}
                key={source.id}
                {...(done
                  ? {}
                  : {
                      onClick: () => {
                        void press(source);
                      },
                    })}
                variant="outline"
              >
                {logo === null ? null : <Logo src={logo} />}
                <ItemContent>
                  <ItemTitle>
                    {source.name}
                    {state === null ? null : (
                      <span {...stylex.props(visuallyHidden)}>, {state}</span>
                    )}
                  </ItemTitle>
                </ItemContent>
              </Item>
            );
          })}
          {namedPlaces.map(({ name, logo }) => {
            const asked = isAsked(name);
            return (
              <Item
                done={asked}
                key={name}
                onClick={() => {
                  void toggleAsked(name);
                }}
                variant="outline"
              >
                <Logo src={logo} />
                <ItemContent>
                  <ItemTitle>
                    {name}
                    {asked ? (
                      <span {...stylex.props(visuallyHidden)}>
                        , {t`asked for`}
                      </span>
                    ) : null}
                  </ItemTitle>
                </ItemContent>
              </Item>
            );
          })}
          {typed.map((name) => {
            const integration = integrationNamed(name);
            const toConnect = connectableNamed(name);
            return (
              <Item
                done
                key={name}
                {...(toConnect === undefined
                  ? {}
                  : {
                      onClick: () => {
                        setConnecting(toConnect);
                      },
                    })}
                variant="outline"
              >
                {integration?.logo === undefined ||
                integration.logo === null ? (
                  <ItemMedia variant="icon">
                    <Icon icon={FileIcon} />
                  </ItemMedia>
                ) : (
                  <Logo src={integration.logo} />
                )}
                <ItemContent>
                  <ItemTitle>
                    {name}
                    <span {...stylex.props(visuallyHidden)}>
                      , {t`asked for`}
                    </span>
                  </ItemTitle>
                </ItemContent>
              </Item>
            );
          })}
          <Item
            onClick={() => {
              setSearching(true);
            }}
            variant="outline"
          >
            <ItemMedia variant="icon">
              <Icon icon={PlusIcon} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t`Something else`}</ItemTitle>
            </ItemContent>
          </Item>
        </ItemGrid>
        <TopError>{failure}</TopError>
      </div>
      <ConnectorSearch
        integrations={integrations}
        onAsk={ask}
        onOpenChange={setSearching}
        onPick={async (integration) => {
          await ask(integration.name);
          if (
            stateOf(integration) !== "shared" &&
            stateOf(integration) !== "personal" &&
            canConnect(integration, identity)
          ) {
            setConnecting(integration);
          }
        }}
        open={searching}
        placeholder={t`Search apps, for example Dropbox`}
      />
      <TopError
        action={{
          label: t`Choose an app again`,
          run: () => {
            setSearching(true);
          },
        }}
        onClose={() => {
          setReturnClosed(true);
        }}
        title={t`The app didn't connect`}
      >
        {returnClosed ? null : returned}
      </TopError>
      {connecting === null ? null : (
        <ConnectDialog
          identity={identity}
          integration={connecting}
          onOpenChange={(open) => {
            if (!open) {
              setConnecting(null);
            }
          }}
          open
          returnTo={sourcesReturn}
        />
      )}
    </CalmStep>
  );
};
