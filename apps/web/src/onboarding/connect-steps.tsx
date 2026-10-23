import type { OAuthProvider } from "@grasp-os/shared/connect";
import { hrPlatforms } from "@grasp-os/shared/onboarding-choices";
import type {
  DocumentSourceId,
  SetupChoices,
} from "@grasp-os/shared/onboarding-choices";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { canConnect, ConnectDialog } from "../connections/connect-dialog.tsx";
import { integrationsOf, stateOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  Asides,
  Heading,
  LaterLink,
  MoreAbout,
  Onward,
  Primary,
  SupportLink,
  tones,
} from "./setup-parts.tsx";
import type { Answer, StepVoice } from "./setup-parts.tsx";
import { documentSources, sourcesFor } from "./setup.ts";
import type { DocumentSource, SetupStep } from "./setup.ts";

// The steps where the admin says what Grasp may connect (prototype
// `Sources`, `RealPulse` and `Leads` in
// `components/onboarding/onboarding-steps.tsx`): where the documents live,
// Pulse on the work laptops, and the HR platform. A place Grasp connects
// through Integrations is connected there, in the connect dialog, by
// whoever may; everything else is noted, for Grasp to set up with them,
// and a place or platform Grasp can't connect to yet is asked for by name.
// Each choice goes to core, which counts it in how much Grasp knows.

/** What a step says as it arrives. */
interface Lines {
  title: string;
  sentence: string;
  voice?: StepVoice;
}

/** What these steps read and how they go on. */
export interface ConnectStepProps {
  lines: Lines;
  choices: SetupChoices;
  /** The suites the company signs in with: their places come first, and only those connect. */
  signIn: readonly OAuthProvider[];
  identity: Identity;
  go: (step: SetupStep) => void;
}

/** Keeps what the admin chose, and reads core again so every step shows it. */
const useSaveChoices = () => {
  const router = useRouter();
  const { run, busy, failure } = useCoreAction();
  const save = async (next: SetupChoices): Promise<boolean> => {
    const kept = await run(
      async (session) => await session.onboarding.saveChoices(next)
    );
    if (kept === undefined) {
      return false;
    }
    await router.invalidate();
    return true;
  };
  return { save, busy, failure };
};

/** The integrations Grasp offers here, with what is connected: none while they load, or if they can't be read. */
const useIntegrations = (): Integration[] => {
  const core = useCore();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
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
        setIntegrations(integrationsOf(catalog.entries, connections));
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

/** How many places a phone shows before "Show more": as many as a sign-in brings. */
const phoneSources = 3;

/** The last row of a list of places: one Grasp can't connect to yet, typed in and asked for. */
const OtherItem = ({
  label,
  placeholder,
  disabled,
  wide,
  folded = false,
  onAdd,
}: {
  label: string;
  placeholder: string;
  disabled: boolean;
  /** Alone on its row: then it takes the whole row, so the grid stays even. */
  wide: boolean;
  /** On a phone, folded away with the rest of a long list until that is shown. */
  folded?: boolean;
  onAdd: (name: string) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  // Opened, the field takes the keys at once, as the button that opened it asked for.
  useEffect(() => {
    if (open) {
      field.current?.focus();
    }
  }, [open]);
  const add = () => {
    const typed = name.trim();
    if (typed === "") {
      return;
    }
    onAdd(typed);
    setName("");
    setOpen(false);
  };
  return (
    <Item
      className={cn(wide && "sm:col-span-2", folded && "max-sm:hidden")}
      size="sm"
      variant="outline"
    >
      <ItemMedia variant="icon">
        <PlusIcon />
      </ItemMedia>
      <ItemContent>
        {open ? (
          <Input
            aria-label={placeholder}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                add();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              }
            }}
            placeholder={placeholder}
            ref={field}
            value={name}
          />
        ) : (
          <ItemTitle>{label}</ItemTitle>
        )}
      </ItemContent>
      <ItemActions>
        <Button
          disabled={disabled || (open && name.trim() === "")}
          onClick={() => {
            if (open) {
              add();
            } else {
              setOpen(true);
            }
          }}
          size="sm"
          variant="outline"
        >
          {open ? t`Ask for it` : t`Add`}
        </Button>
      </ItemActions>
    </Item>
  );
};

/** A row's state, said with a check: noted, or connected. */
const Settled = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground flex items-center gap-1">
    <CheckIcon className="text-status-agreed size-4" />
    {children}
  </span>
);

/**
 * Where the documents live: six places, those of the company's sign-in
 * first, and another one asked for by name. Pressed, a place is noted;
 * where Grasp connects it through Integrations, its sign-in follows in the
 * connect dialog, and it is connected once that is done.
 */
export const Sources = ({
  lines,
  choices,
  signIn,
  identity,
  go,
}: ConnectStepProps) => {
  const { t } = useLingui();
  const { save, busy, failure } = useSaveChoices();
  const integrations = useIntegrations();
  // The last one noted on this visit: Stephen says so.
  const [fresh, setFresh] = useState<DocumentSourceId | null>(null);
  // The last one asked for on this visit: Stephen says it is passed on.
  const [asked, setAsked] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Integration | null>(null);
  const [all, setAll] = useState(false);
  const listed = sourcesFor(signIn);
  const noted = choices.sources;
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
  const connect = async (source: DocumentSource) => {
    const kept =
      noted.includes(source.id) ||
      (await save({ ...choices, sources: [...noted, source.id] }));
    if (!kept) {
      return;
    }
    setFresh(source.id);
    setAsked(null);
    setConnecting(connectable(source) ?? null);
  };
  const ask = async (name: string) => {
    const known = wanted.some(
      (each) => each.toLowerCase() === name.toLowerCase()
    );
    if (
      known ||
      (await save({ ...choices, sourcesWanted: [...wanted, name] }))
    ) {
      setAsked(name);
      setFresh(null);
    }
  };
  const count = noted.length;
  let more = t`Anything else?`;
  if (count >= 4) {
    more = t`That’s plenty to start with. Let’s move on.`;
  } else if (count >= 2) {
    more = t`Anything else you’d like to connect?`;
  }
  const freshSource = documentSources.find(({ id }) => id === fresh);
  let answer: Answer | undefined;
  if (freshSource !== undefined) {
    const { name } = freshSource;
    let said = t`Noted: ${name}. We’ll connect it with you, and I’ll only read what you share with me.`;
    if (isConnected(freshSource)) {
      said = t`${name} is connected. I’ll only read what you share with me.`;
    } else if (connectable(freshSource) !== undefined) {
      said = t`Noted: ${name}. Sign in to connect it now, or we’ll connect it with you. I’ll only read what you share with me.`;
    }
    answer = { text: `${said} ${more}`, tone: tones.plain };
  } else if (asked !== null) {
    answer = {
      text: t`Thank you. I’ve asked our team to add ${asked}. For now, add those documents in the next step.`,
      tone: tones.even,
      quick: true,
    };
  }
  // On a phone only the first few show, and whatever is already in; the rest waits behind "Show more".
  const folded = (source: DocumentSource, index: number): boolean =>
    index >= phoneSources && !noted.includes(source.id);
  const listRef = useRef<HTMLDivElement>(null);
  // Shown, the keys go on from the first place that was folded away.
  useEffect(() => {
    if (all) {
      listRef.current
        ?.querySelector<HTMLElement>("[data-folded] button")
        ?.focus();
    }
  }, [all]);
  return (
    <>
      <Heading
        answer={answer}
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      <Onward>
        <ItemGroup
          className="grid w-full text-left sm:grid-cols-2"
          ref={listRef}
        >
          {listed.map((source, index) => {
            const { name } = source;
            const away = folded(source, index);
            const offered = connectable(source);
            let action: ReactNode = (
              <Button
                aria-label={t`Connect ${name}`}
                disabled={busy}
                onClick={() => {
                  void connect(source);
                }}
                size="sm"
                variant="outline"
              >
                {t`Connect`}
              </Button>
            );
            if (noted.includes(source.id) && isConnected(source)) {
              action = <Settled>{t`Connected`}</Settled>;
            } else if (noted.includes(source.id)) {
              action = (
                <>
                  <Settled>{t`Noted`}</Settled>
                  {offered === undefined ? null : (
                    <Button
                      aria-label={t`Sign in to connect ${name} now`}
                      onClick={() => {
                        setConnecting(offered);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {t`Sign in`}
                    </Button>
                  )}
                </>
              );
            }
            return (
              <Item
                className={cn(away && !all && "max-sm:hidden")}
                data-folded={away || undefined}
                key={source.id}
                size="sm"
                variant="outline"
              >
                <ItemMedia>
                  <AppLogo name={name} size="sm" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                </ItemContent>
                <ItemActions>{action}</ItemActions>
              </Item>
            );
          })}
          {wanted.map((name) => (
            <Item key={name} size="sm" variant="outline">
              <ItemMedia>
                <AppLogo name={name} size="sm" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground">{t`Asked for`}</span>
              </ItemActions>
            </Item>
          ))}
          <OtherItem
            disabled={busy}
            folded={!all}
            label={t`Something else`}
            onAdd={(name) => {
              void ask(name);
            }}
            placeholder={t`Where, for example Dropbox`}
            wide={(listed.length + wanted.length) % 2 === 0}
          />
        </ItemGroup>
        {all ? null : (
          <Button
            className="-mt-3 sm:hidden"
            onClick={() => {
              setAll(true);
            }}
            size="sm"
            variant="ghost"
          >
            {t`Show more`}
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        )}
        <ErrorText>{failure}</ErrorText>
      </Onward>
      <Primary
        onClick={() => {
          go("documents");
        }}
        ready={count > 0 || wanted.length > 0}
      >
        {t`Continue`}
      </Primary>
      <Asides>
        {count === 0 && wanted.length === 0 ? (
          <LaterLink
            onClick={() => {
              go("documents");
            }}
          >
            {t`Skip for now`}
          </LaterLink>
        ) : null}
        <SupportLink page="documents">{t`More about these connections`}</SupportLink>
      </Asides>
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
    </>
  );
};

/**
 * Pulse on the work laptops: there is nothing to download here yet, so the
 * admin says whether they want it, and Grasp sets it up with them or their
 * IT; or they skip it.
 */
export const Pulse = ({ lines, choices, go }: ConnectStepProps) => {
  const { t } = useLingui();
  const { save, busy, failure } = useSaveChoices();
  const wanted = choices.pulse === "wanted";
  return (
    <>
      <Heading
        answer={
          wanted
            ? {
                text: t`Noted. We’ll get in touch to put it on the laptops with you.`,
                tone: tones.even,
                quick: true,
              }
            : undefined
        }
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      {wanted ? (
        <>
          <Primary
            onClick={() => {
              go("leads");
            }}
          >
            {t`Continue`}
          </Primary>
          <MoreAbout page="pulse">{t`More about Pulse`}</MoreAbout>
        </>
      ) : (
        <>
          <Primary
            busy={busy}
            onClick={() => {
              void save({ ...choices, pulse: "wanted" });
            }}
          >
            {t`Yes, set it up with us`}
          </Primary>
          <Asides>
            <LaterLink
              onClick={() => {
                void (async () => {
                  if (await save({ ...choices, pulse: "skipped" })) {
                    go("leads");
                  }
                })();
              }}
            >
              {t`Skip for now`}
            </LaterLink>
            <SupportLink page="pulse">{t`More about Pulse`}</SupportLink>
          </Asides>
          <ErrorText>{failure}</ErrorText>
        </>
      )}
    </>
  );
};

/**
 * The HR platform, before the organization is confirmed: one named, which
 * Grasp sets up with them; another asked for by name; or none. Meanwhile
 * the leads come from the organization the admin confirms next
 * (`onDone`).
 */
export const HrPlatform = ({
  lines,
  choices,
  onDone,
}: Omit<ConnectStepProps, "go" | "signIn" | "identity"> & {
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const { save, busy, failure } = useSaveChoices();
  const { hr } = choices;
  const choose = async (next: SetupChoices["hr"]) => {
    await save({ ...choices, hr: next });
  };
  let answer: Answer | undefined;
  if (hr?.kind === "platform") {
    const { name } = hr;
    answer = {
      text: t`Noted: ${name}. We’ll connect it with you. Meanwhile, check who leads which team.`,
      tone: tones.plain,
      quick: true,
    };
  } else if (hr?.kind === "asked") {
    const { name } = hr;
    answer = {
      text: t`Thank you. I’ve asked our team to connect ${name}. For now, check who leads which team.`,
      tone: tones.even,
      quick: true,
    };
  }
  return (
    <>
      <Heading
        answer={answer}
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      {hr === null || hr.kind === "none" ? (
        <>
          <Onward>
            <ItemGroup className="grid w-full text-left sm:grid-cols-2">
              {hrPlatforms.map((name) => (
                <Item key={name} size="sm" variant="outline">
                  <ItemMedia>
                    <AppLogo name={name} size="sm" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{name}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={t`Connect ${name}`}
                      disabled={busy}
                      onClick={() => {
                        void choose({ kind: "platform", name });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {t`Connect`}
                    </Button>
                  </ItemActions>
                </Item>
              ))}
              <OtherItem
                disabled={busy}
                label={t`Another platform`}
                onAdd={(name) => {
                  void choose({ kind: "asked", name });
                }}
                placeholder={t`Name of your HR platform`}
                wide={hrPlatforms.length % 2 === 0}
              />
            </ItemGroup>
            <ErrorText>{failure}</ErrorText>
          </Onward>
          <Asides>
            <LaterLink
              onClick={() => {
                void (async () => {
                  if (await save({ ...choices, hr: { kind: "none" } })) {
                    onDone();
                  }
                })();
              }}
            >
              {t`We don’t use an HR platform`}
            </LaterLink>
            <SupportLink page="hr">{t`More about this connection`}</SupportLink>
          </Asides>
        </>
      ) : (
        <>
          <Primary onClick={onDone}>{t`Continue`}</Primary>
          <Asides>
            <LaterLink
              onClick={() => {
                void choose(null);
              }}
            >
              {t`Use another platform`}
            </LaterLink>
            <SupportLink page="hr">{t`More about this connection`}</SupportLink>
          </Asides>
        </>
      )}
    </>
  );
};
