import {
  canSignInAgain,
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type {
  CatalogTool,
  ConnectionScope,
  ListedConnection,
  OAuthProvider,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { Alert } from "../grasp/alert/index.ts";
import type { ButtonWords } from "../grasp/button/button.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../grasp/field/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { arrive } from "../grasp/motion/arrive.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Stepper } from "../grasp/stepper/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import type { Integration } from "./integrations.ts";
import { ToolChoice } from "./tool-choice.tsx";
import { toolRules, withAllowed, withRead } from "./tool-choices.ts";
import type { AllowedTool } from "./tool-choices.ts";

// Connecting an app, as the prototype's one dialog does it
// (`components/connect-dialog.tsx`), in numbered steps: for a Composio
// toolkit, an admin first chooses what Grasp may do and consents; then the
// person signs in at the app, which sends them back to its page here.
// Signing in again to a connection whose access ran out is the same sign-in
// for its provider and scope. Core and connect check every step: the page
// offers only what the role can do.

/**
 * Where a flow sends the browser back to: the integration's own page, which
 * says the app is connected again when `again`.
 */
export const returnToOf = (key: string, again = false): string =>
  again ? `/integrations/${key}?again=1` : `/integrations/${key}`;

/** Sends the browser to the provider, once core started the flow. */
export const goTo = (started: { url: string } | undefined): void => {
  if (started !== undefined) {
    window.location.assign(started.url);
  }
};

/**
 * Whether this person can start connecting `integration`: never Grasp
 * staff, never an entry that isn't offered (core refuses admins too), never
 * one that needs the organization's own sign-in app (connect refuses it);
 * a native provider for anyone, a Composio toolkit for admins.
 */
export const canConnect = (
  integration: Integration,
  identity: Identity
): boolean => {
  if (identity.staff || !integration.offered || integration.auth === "own") {
    return false;
  }
  if (integration.source === "native") {
    return oauthProviderSchema.safeParse(integration.id).success;
  }
  return isAdmin(identity.role);
};

/** Whether this person can sign in again to `connection`, as core decides it. */
export const canReconnect = (
  connection: ListedConnection,
  offered: boolean,
  identity: Pick<Identity, "role" | "staff">
): boolean => canSignInAgain(connection, offered, identity);

/**
 * The connection an integration's page offers to sign in to again: the
 * first whose access ran out that this person may sign in to again. An
 * active one has nothing to sign in to again: connect refuses it as
 * already connected.
 */
export const signInAgainTarget = (
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): ListedConnection | undefined =>
  integration.connections.find(
    (connection) =>
      connection.status === "needs_reauth" &&
      canReconnect(connection, integration.offered, identity)
  );

const styles = stylex.create({
  flow: { display: "grid", gap: grasp.space4 },
  part: { display: "grid", gap: grasp.space2 },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  waiting: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: grasp.controlMd,
  },
  // The tools to choose from, scrolled within the dialog past a few.
  tools: { maxHeight: "16rem", overflowY: "auto" },
});

/**
 * A step's part of the dialog: what it asks. Grasp UI's Stepper above names
 * the steps and says where they stand, and the dialog's title names a flow
 * of one, so the step's own name is said only to a screen reader, as the
 * heading its part sits under: shown, it would say the Stepper's words
 * again. The Stepper takes a line under each name, not its controls, so
 * each step's controls stand here, in order.
 */
const Step = ({
  title,
  state,
  children,
}: {
  title: string;
  state: StepState;
  children: ReactNode;
}) => (
  <section data-state={state} {...stylex.props(styles.part)}>
    <h3 {...stylex.props(visuallyHidden)}>{title}</h3>
    {children}
  </section>
);

/** Where a step is: waiting its turn, the one to act on, or done. */
type StepState = "idle" | "active" | "done";

/** The Stepper over a flow's steps, from where each stands; none for one step. */
const Progress = ({
  steps,
}: {
  steps: readonly { title: string; state: StepState }[];
}) => {
  const { t } = useLingui();
  if (steps.length < 2) {
    return null;
  }
  const current = steps.findIndex(({ state }) => state === "active");
  return (
    <Stepper
      aria-label={t`Steps`}
      steps={steps.map(({ title }) => ({ label: title }))}
      value={current === -1 ? steps.length : current}
    />
  );
};

/**
 * Starting the sign-in at core, which answers with the provider's address
 * to send the browser to. "Try again" starts another attempt while one is
 * still waiting: only the newest attempt counts, so an older one that
 * answers late neither sends the browser away nor ends the wait. `attempt`
 * numbers them, so the waiting row starts over with each.
 */
const useSignInStart = () => {
  const core = useCore();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const newest = useRef(0);
  const begin = async (
    action: (session: Session) => Promise<{ url: string }>
  ): Promise<void> => {
    newest.current += 1;
    const mine = newest.current;
    setAttempt(mine);
    setBusy(true);
    setFailure(undefined);
    try {
      const started = await core.withSession(action);
      if (newest.current === mine) {
        // Still busy: the browser leaves for the provider.
        goTo(started);
      }
    } catch (error) {
      if (newest.current === mine) {
        setFailure(failureText(error));
        setBusy(false);
      }
    }
  };
  return { attempt, begin, busy, failure };
};

/** How long a start may take before the dialog offers to try again. */
const takingLongMs = 6000;

/**
 * While core starts the sign-in: a spinner row and, once it takes long,
 * a way to try again, as in the prototype (`Waiting`). Trying again is
 * held to what the step's own button is: with every tool switched off
 * meanwhile, there is nothing to start.
 */
const Starting = ({
  app,
  disabled,
  onRetry,
}: {
  app: string;
  disabled: boolean;
  onRetry: () => void;
}) => {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLong(true);
    }, takingLongMs);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.part)}>
      <output {...stylex.props(styles.waiting)}>
        <Spinner aria-hidden />
        {t`Waiting for ${app}`}
      </output>
      {long ? (
        <div {...stylex.props(styles.actions)}>
          <Text element="span" size="sm" tone="muted">
            {t`Taking long?`}
          </Text>
          <Button
            disabled={disabled}
            onClick={onRetry}
            size="xs"
            variant="ghost"
          >
            {t`Try again`}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

/**
 * The step's button, Cancel beside it; while core starts the sign-in, the
 * waiting row instead.
 */
const Actions = ({
  app,
  attempt,
  busy,
  disabled = false,
  onClose,
  onStart,
  children,
  cancel,
}: {
  app: string;
  /** Which attempt is waiting: each starts the waiting row over. */
  attempt: number;
  busy: boolean;
  disabled?: boolean;
  onClose: () => void;
  onStart: () => void;
  children: ButtonWords;
  /** Cancel, in the page's language. */
  cancel: string;
}) =>
  // Each state its own key, so the one that comes in arrives anew (and
  // each attempt's waiting row starts over), rather than swapping in place.
  busy ? (
    <div
      data-slot="fade-in"
      key={`starting-${attempt}`}
      {...stylex.props(arrive.in)}
    >
      <Starting app={app} disabled={disabled} onRetry={onStart} />
    </div>
  ) : (
    <div
      data-slot="fade-in"
      key="ready"
      {...stylex.props(styles.actions, arrive.in)}
    >
      <Button disabled={disabled} onClick={onStart} variant="ink">
        {children}
      </Button>
      <Button onClick={onClose}>{cancel}</Button>
    </div>
  );

/**
 * Where a native provider's sign-in page is, shown as the prototype shows
 * it: the host connect sends the browser to (apps/connect/src/providers.ts).
 */
export const signInHosts: Readonly<Record<OAuthProvider, string>> = {
  microsoft: "login.microsoftonline.com",
  google: "accounts.google.com",
};

/** The sign-in host of `integration`, when it is a native provider's. */
export const signInHostOf = (integration: Integration): string | undefined => {
  if (integration.source !== "native") {
    return undefined;
  }
  const provider = oauthProviderSchema.safeParse(integration.id);
  return provider.success ? signInHosts[provider.data] : undefined;
};

/** What signing in means, in three rows; where it happens, when known. */
const SignInSteps = ({ app, host }: { app: string; host?: string }) => {
  const { t } = useLingui();
  const lines = [
    host === undefined
      ? t`You sign in on ${app}’s own page.`
      : t({
          message: `You sign in at ${host}`,
          comment:
            "{host} is the web address of the sign-in page, e.g. login.microsoftonline.com.",
        }),
    t`You approve there. ${app} shows what Grasp asks for.`,
    t`You come back to ${app}’s page here.`,
  ];
  return (
    <>
      <Text size="sm" tone="muted">
        {t`Signing in happens at ${app}. It takes about a minute.`}
      </Text>
      <ItemGroup aria-label={t`Signing in`} separated>
        {lines.map((line) => (
          <Item key={line} size="xs" variant="outline">
            <ItemContent>
              <ItemTitle>{line}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </>
  );
};

/** An admin's choice: connect for themselves, or for everyone, chosen by its words. */
const ScopeChoice = ({
  scope,
  onScope,
}: {
  scope: ConnectionScope;
  onScope: (scope: ConnectionScope) => void;
}) => {
  const { t } = useLingui();
  return (
    <RadioGroup
      aria-label={t`Who uses it`}
      onValueChange={(value) => {
        onScope(value === "shared" ? "shared" : "personal");
      }}
      value={scope}
    >
      <Field orientation="horizontal">
        <RadioGroupItem
          // A press on the option already chosen accepts it too.
          onClick={() => {
            onScope("personal");
          }}
          value="personal"
        />
        <FieldContent>
          <FieldLabel>{t`Just for you`}</FieldLabel>
          <FieldDescription>{t`Only you can use it.`}</FieldDescription>
        </FieldContent>
      </Field>
      <Field orientation="horizontal">
        <RadioGroupItem
          onClick={() => {
            onScope("shared");
          }}
          value="shared"
        />
        <FieldContent>
          <FieldLabel>{t`For everyone`}</FieldLabel>
          <FieldDescription>
            {t`Your organization uses it through the permissions you grant.`}
          </FieldDescription>
        </FieldContent>
      </Field>
    </RadioGroup>
  );
};

/** The native provider's sign-in: who uses it (an admin chooses), then signing in. */
const NativeFlow = ({
  integration,
  identity,
  again,
  returnTo,
  onClose,
}: {
  integration: Integration;
  identity: Identity;
  /** The connection to sign in to again, keeping its scope. */
  again: ListedConnection | undefined;
  returnTo: string;
  onClose: () => void;
}) => {
  const { attempt, begin, busy, failure } = useSignInStart();
  const { t } = useLingui();
  const [scope, setScope] = useState<ConnectionScope>(
    again?.scope ?? "personal"
  );
  // Done once the admin chose who uses it, the default (just for them)
  // included: by picking an option, or by going on to sign in with it.
  const [chose, setChose] = useState(false);
  const provider = oauthProviderSchema.safeParse(integration.id);
  const app = integration.name;
  const start = async (): Promise<void> => {
    if (!provider.success) {
      return;
    }
    setChose(true);
    await begin(
      async (session) =>
        await session.connections.start({
          provider: provider.data,
          scope,
          returnTo,
        })
    );
  };
  const signIn = (
    <>
      <SignInSteps app={app} host={signInHostOf(integration)} />
      <Actions
        app={app}
        attempt={attempt}
        busy={busy}
        cancel={t`Cancel`}
        onClose={onClose}
        onStart={() => {
          void start();
        }}
      >
        {t`Sign in to ${app}`}
      </Actions>
      {failure === undefined ? null : (
        <Alert title={failure} variant="danger" />
      )}
    </>
  );
  if (again !== undefined || !isAdmin(identity.role)) {
    return (
      <div {...stylex.props(styles.flow)}>
        <Step state="active" title={t`Sign in`}>
          {signIn}
        </Step>
      </div>
    );
  }
  const steps = [
    { title: t`Who uses it`, state: chose ? "done" : "active" },
    { title: t`Sign in`, state: chose ? "active" : "idle" },
  ] as const;
  return (
    <div {...stylex.props(styles.flow)}>
      <Progress steps={steps} />
      <Step state={steps[0].state} title={steps[0].title}>
        <ScopeChoice
          onScope={(chosen) => {
            setScope(chosen);
            setChose(true);
          }}
          scope={scope}
        />
      </Step>
      <Step state={steps[1].state} title={steps[1].title}>
        {signIn}
      </Step>
    </div>
  );
};

/**
 * Connecting a Composio toolkit, for an admin: the tools to allow and which
 * of them only read, the consent as written, then signing in. A read-only
 * tool runs without asking; a call of any other is a side effect, which
 * waits for its person to confirm it wherever a person is there (chat, an
 * App they use), and which a workflow's run makes as a step.
 */
const ComposioFlow = ({
  integration,
  returnTo,
  onClose,
}: {
  integration: Integration;
  returnTo: string;
  onClose: () => void;
}) => {
  const { attempt, begin, busy, failure } = useSignInStart();
  const core = useCore();
  const [listed, setListed] = useState<Loaded<CatalogTool[]>>();
  const [allowed, setAllowed] = useState<AllowedTool[]>([]);
  const { t, i18n } = useLingui();
  const app = integration.name;
  const { source, id } = integration;
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.connections.catalogTools(source, id),
        left.signal
      );
      if (!left.signal.aborted) {
        setListed(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core, source, id]);
  const tools = listed?.state === "ready" ? listed.data : undefined;
  const connect = async (): Promise<void> => {
    await begin(
      async (session) =>
        await session.connections.connectToolkit({
          toolkit: integration.id,
          tools: toolRules(allowed),
          consent: composioConsentText,
          returnTo,
        })
    );
  };
  const steps = [
    {
      title: t`What Grasp may do`,
      state: allowed.length === 0 ? "active" : "done",
    },
    {
      title: t`Consent and sign in`,
      state: allowed.length === 0 ? "idle" : "active",
    },
  ] as const;
  return (
    <div {...stylex.props(styles.flow)}>
      <Progress steps={steps} />
      <Step state={steps[0].state} title={steps[0].title}>
        <Text size="sm" tone="muted">
          {t`A tool switched on starts as Read where Composio says it only reads; Grasp doesn't check that. A Read tool runs without asking. A call of a Write tool from chat, or from a person using an App, waits for that person to confirm it; a workflow's run makes it as one of its steps. Press a tool's Read or Write to change it. Mark a tool Read only if it changes nothing: marked wrongly, it changes things without asking.`}
        </Text>
        {listed === undefined ? <LoadingLines /> : null}
        {listed === undefined || listed.state === "ready" ? null : (
          <Alert title={notLoadedText(listed, i18n) ?? ""} variant="danger" />
        )}
        {tools === undefined ? null : (
          <div {...stylex.props(styles.tools, arrive.in)}>
            <ItemGroup aria-label={t`Tools to allow`} separated>
              {tools.map((tool) => (
                <ToolChoice
                  choice={allowed.find((choice) => choice.name === tool.name)}
                  key={tool.name}
                  onAllow={(allow) => {
                    setAllowed((current) => withAllowed(current, tool, allow));
                  }}
                  onRead={(read) => {
                    setAllowed((current) => withRead(current, tool.name, read));
                  }}
                  tool={tool}
                />
              ))}
            </ItemGroup>
          </div>
        )}
      </Step>
      <Step state={steps[1].state} title={steps[1].title}>
        {/* The consent stays as written: core keeps a hash of the exact
            text consented to (connection-list.tsx shows it again). */}
        <Text size="sm" tone="muted">
          {composioConsentText}
        </Text>
        <SignInSteps app={app} />
        <Actions
          app={app}
          attempt={attempt}
          busy={busy}
          cancel={t`Cancel`}
          disabled={allowed.length === 0}
          onClose={onClose}
          onStart={() => {
            void connect();
          }}
        >
          {t`Consent and connect`}
        </Actions>
        {failure === undefined ? null : (
          <Alert title={failure} variant="danger" />
        )}
      </Step>
    </div>
  );
};

/**
 * The dialog: connecting `integration`, or signing in again to `again`.
 * Open only for someone `canConnect` or `canReconnect` allows. The flow
 * sends the browser back to `returnTo`: by default the integration's page.
 */
export const ConnectDialog = ({
  integration,
  identity,
  again,
  returnTo,
  open,
  onOpenChange,
}: {
  integration: Integration;
  identity: Identity;
  again?: ListedConnection;
  returnTo?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const app = integration.name;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>
          {again === undefined ? t`Connect ${app}` : t`Sign in to ${app} again`}
        </DialogTitle>
        <DialogDescription>
          {integration.source === "native"
            ? t`Through Grasp's own connector, which keeps the access in your deployment. Your workflows can use it once it is connected, only for what you allow.`
            : t`Through Composio, which keeps the access in its own cloud. Your workflows can use it once it is connected, only for what you allow.`}
        </DialogDescription>
        <DialogBody>
          {/* Only while open, so each opening starts from its first step. */}
          {open && integration.source === "native" ? (
            <NativeFlow
              again={again}
              identity={identity}
              integration={integration}
              onClose={() => {
                onOpenChange(false);
              }}
              returnTo={
                returnTo ?? returnToOf(integration.key, again !== undefined)
              }
            />
          ) : null}
          {open && integration.source === "composio" ? (
            <ComposioFlow
              integration={integration}
              onClose={() => {
                onOpenChange(false);
              }}
              returnTo={returnTo ?? returnToOf(integration.key)}
            />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
