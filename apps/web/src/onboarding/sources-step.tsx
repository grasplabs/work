import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import type { ContextWords } from "@grasp-os/shared/onboarding-context";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { canConnect, ConnectDialog } from "../connections/connect-dialog.tsx";
import { integrationsOf, stateOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { isLocale } from "../i18n.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
import { OtherRow } from "./other-row.tsx";
import { sourcesFor } from "./setup.ts";
import type { DocumentSource } from "./setup.ts";
import type { SetupData, StepProps } from "./step-parts.ts";
import { SupportLink } from "./support-link.tsx";

// Where the documents live: the places, those of the company's sign-in
// and those the kickoff named first, each a row pressed to note it; where
// Grasp connects it through Integrations, its sign-in follows in the
// connect dialog. Another place is asked for by name. Each choice goes to
// core, which counts it in how much Grasp knows.

const styles = stylex.create({
  stack: { display: "grid", gap: space[3] },
});

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
const useIntegrations = (): Integration[] => {
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
  const integrations = useIntegrations();
  const [connecting, setConnecting] = useState<Integration | null>(null);
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
  const ask = async (name: string) => {
    const known = wanted.some(
      (each) => each.toLowerCase() === name.toLowerCase()
    );
    if (!known) {
      await save({ ...choices, sourcesWanted: [...wanted, name] });
    }
  };
  const stateOfRow = (source: DocumentSource): ReactNode => {
    if (!noted.includes(source.id)) {
      return null;
    }
    return isConnected(source) ? (
      <Badge variant="success">{t`Connected`}</Badge>
    ) : (
      <Badge variant="secondary">{t`Noted`}</Badge>
    );
  };
  return (
    <CalmStep
      body={
        kinds === null
          ? t`Procedures, handbooks, how-tos. Connect where they live, and I’ll only read what you share with me.`
          : t`${kinds}. Connect where they live, and I’ll only read what you share with me.`
      }
      end={
        <>
          <Button
            onClick={() => {
              onward();
            }}
            size="lg"
          >
            {t`Continue`}
          </Button>
          <SupportLink page="documents">{t`More about these connections`}</SupportLink>
        </>
      }
      title={t`Where does the work get written down?`}
    >
      <div {...stylex.props(styles.stack)}>
        <ItemGroup aria-label={t`Where your documents live`}>
          {listed.map((source) => {
            const state = stateOfRow(source);
            const done = noted.includes(source.id) && isConnected(source);
            return (
              <Item
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
                <ItemContent>
                  <ItemTitle>{source.name}</ItemTitle>
                </ItemContent>
                {state === null ? null : <ItemActions>{state}</ItemActions>}
              </Item>
            );
          })}
          {wanted.map((name) => (
            <Item key={name} variant="outline">
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <Badge variant="secondary">{t`Asked for`}</Badge>
              </ItemActions>
            </Item>
          ))}
          <OtherRow
            disabled={busy}
            label={t`Something else`}
            onAdd={(name) => {
              void ask(name);
            }}
            placeholder={t`Where, for example Dropbox`}
          />
        </ItemGroup>
        <ErrorText>{failure}</ErrorText>
      </div>
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
