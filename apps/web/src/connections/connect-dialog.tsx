import {
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
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Switch } from "@grasp-os/ui/components/switch";
import { Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, EyeIcon, LockIcon, PenLineIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { AppLogo } from "./app-logo.tsx";
import type { Integration } from "./integrations.ts";
import { toolRules, withAllowed, withRead } from "./tool-choices.ts";
import type { AllowedTool } from "./tool-choices.ts";

// Connecting an app, as the prototype's one dialog does it
// (`components/connect-dialog.tsx`), in numbered steps: for a Composio
// toolkit, an admin first chooses what Grasp may do and consents; then the
// person signs in at the app, which sends them back to its page here.
// Signing in again to a connection whose access ran out is the same sign-in
// for its provider and scope. Core and connect check every step: the page
// offers only what the role can do.

/** Where a flow sends the browser back to: the integration's own page. */
export const returnToOf = (key: string): string => `/integrations/${key}`;

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

/**
 * Whether this person can sign in again to `connection`: whoever may
 * disconnect it (its owner, or an admin for a shared one), never Grasp
 * staff, only a native one, and only while its entry is offered.
 */
export const canReconnect = (
  connection: ListedConnection,
  offered: boolean,
  identity: Pick<Identity, "role" | "staff">
): boolean =>
  connection.source === "native" &&
  oauthProviderSchema.safeParse(connection.provider).success &&
  offered &&
  (connection.scope === "personal" || isAdmin(identity.role)) &&
  !identity.staff;

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

/** Where a step is: waiting its turn, the one to act on, or done. */
type StepState = "idle" | "active" | "done";

const ringClass: Readonly<Record<StepState, string>> = {
  idle: "bg-card text-muted-foreground grid size-6 place-items-center rounded-full border text-xs transition-colors duration-300",
  active:
    "border-foreground bg-card grid size-6 place-items-center rounded-full border text-xs font-medium transition-colors duration-300",
  done: "bg-muted grid size-6 place-items-center rounded-full border border-transparent transition-colors duration-300",
};

/**
 * A step's number in a ring, as in the prototype (`StepRing`): grey while
 * it waits, dark while it is the one to act on, and a check that pops in
 * once it is done.
 */
const StepRing = ({ n, state }: { n: number; state: StepState }) => {
  const { t } = useLingui();
  return (
    <span className={ringClass[state]}>
      {state === "done" ? (
        <CheckIcon
          aria-label={t({
            message: "Done",
            context: "a step that is finished",
          })}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-50 size-3.5 motion-safe:duration-300"
        />
      ) : (
        n
      )}
    </span>
  );
};

/** A step: its ring, its title (muted unless it is the one to act on), and what it asks. */
const Step = ({
  n,
  title,
  state,
  last = false,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  last?: boolean;
  children: ReactNode;
}) => (
  <li className="flex gap-3" data-state={state}>
    <div className="flex w-6 flex-none flex-col items-center">
      <StepRing n={n} state={state} />
      {last ? null : (
        <span
          aria-hidden="true"
          className="my-1 w-px flex-1 border-l border-dashed"
        />
      )}
    </div>
    <div
      className={
        last
          ? "flex min-w-0 flex-1 flex-col gap-2"
          : "flex min-w-0 flex-1 flex-col gap-2 pb-5"
      }
    >
      <h3
        className={
          state === "active"
            ? "flex h-6 items-center font-medium transition-colors"
            : "text-muted-foreground flex h-6 items-center transition-colors"
        }
      >
        {title}
      </h3>
      {children}
    </div>
  </li>
);

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
 * a way to try again, as in the prototype (`Waiting`).
 */
const Starting = ({ app, onRetry }: { app: string; onRetry: () => void }) => {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLong(true);
    }, takingLongMs);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <output className="flex h-10 items-center gap-2 rounded-lg border px-3">
        <span className="text-muted-foreground">
          <Spinner className="size-3.5" />
        </span>
        <Trans>Waiting for {app}</Trans>
      </output>
      {long ? (
        <p className="text-muted-foreground">
          <Trans>
            Taking long?{" "}
            <Button onClick={onRetry} size="xs" variant="link">
              Try again
            </Button>
          </Trans>
        </p>
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
}: {
  app: string;
  /** Which attempt is waiting: each starts the waiting row over. */
  attempt: number;
  busy: boolean;
  disabled?: boolean;
  onClose: () => void;
  onStart: () => void;
  children: ReactNode;
}) =>
  busy ? (
    <Starting app={app} key={attempt} onRetry={onStart} />
  ) : (
    <div className="flex items-center gap-2">
      <Button disabled={disabled} onClick={onStart}>
        {children}
      </Button>
      <Button onClick={onClose} variant="outline">
        <Trans>Cancel</Trans>
      </Button>
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

/** What signing in means, in three lines; where it happens, when known. */
const SignInSteps = ({ app, host }: { app: string; host?: string }) => (
  <>
    <p className="text-muted-foreground">
      <Trans>Signing in happens at {app}. It takes about a minute.</Trans>
    </p>
    <ol className="flex flex-col overflow-hidden rounded-lg border">
      <li className="flex min-h-11 flex-wrap items-center gap-1 border-b px-3 py-2.5">
        {host === undefined ? (
          <Trans>You sign in on {app}’s own page.</Trans>
        ) : (
          <Trans comment="{host} is the web address of the sign-in page, e.g. login.microsoftonline.com.">
            You sign in at{" "}
            <span className="bg-muted rounded-sm border px-1 font-mono text-xs">
              {host}
            </span>
          </Trans>
        )}
      </li>
      <li className="flex min-h-11 items-center border-b px-3 py-2.5">
        <Trans>You approve there. {app} shows what Grasp asks for.</Trans>
      </li>
      <li className="flex min-h-11 items-center px-3 py-2.5">
        <Trans>You come back to {app}’s page here.</Trans>
      </li>
    </ol>
  </>
);

/** One of the scope choice's options: its radio, its name and what it means. */
const ScopeOption = ({
  value,
  scope,
  onScope,
  children,
}: {
  value: ConnectionScope;
  scope: ConnectionScope;
  onScope: (scope: ConnectionScope) => void;
  children: ReactNode;
}) => (
  <label className="has-checked:bg-muted flex cursor-pointer items-start gap-3 border-b px-3 py-2.5 last:border-b-0">
    <input
      checked={scope === value}
      className="accent-primary mt-1"
      name="scope"
      onChange={() => {
        onScope(value);
      }}
      // A click on the option already chosen accepts it too, which
      // changes nothing and so fires no change.
      onClick={() => {
        onScope(value);
      }}
      type="radio"
    />
    <span className="flex flex-col gap-0.5">{children}</span>
  </label>
);

/** An admin's choice: connect for themselves, or for everyone. */
const ScopeChoice = ({
  scope,
  onScope,
}: {
  scope: ConnectionScope;
  onScope: (scope: ConnectionScope) => void;
}) => (
  <fieldset className="flex flex-col overflow-hidden rounded-lg border">
    {/* The step's title says it on screen. */}
    <legend className="sr-only">
      <Trans>Who uses it</Trans>
    </legend>
    <ScopeOption onScope={onScope} scope={scope} value="personal">
      <span>
        <Trans>Just for you</Trans>
      </span>
      <span className="text-muted-foreground">
        <Trans>Only you can use it.</Trans>
      </span>
    </ScopeOption>
    <ScopeOption onScope={onScope} scope={scope} value="shared">
      <span>
        <Trans>For everyone</Trans>
      </span>
      <span className="text-muted-foreground">
        <Trans>
          Your organization uses it through the permissions you grant.
        </Trans>
      </span>
    </ScopeOption>
  </fieldset>
);

/** A tool that is off: Grasp never calls it. */
const NeverBadge = () => (
  <Badge variant="outline">
    <LockIcon data-icon="inline-start" />
    <Trans context="what a tool may do">Never</Trans>
  </Badge>
);

/**
 * One tool of a toolkit, as the prototype's permission row: a switch to
 * allow it, and a badge with what it may do: Never while it is off, Read
 * when it only reads, Write when it changes things. An allowed tool's badge
 * is a button that switches it between Read and Write (tool-choices.ts).
 */
const ToolChoice = ({
  tool,
  choice,
  onAllow,
  onRead,
}: {
  tool: CatalogTool;
  choice: AllowedTool | undefined;
  onAllow: (allow: boolean) => void;
  onRead: (read: boolean) => void;
}) => {
  const { t } = useLingui();
  const { name } = tool;
  const id = `connect-tool-${name}`;
  return (
    <li className="flex min-h-11 items-center gap-2 border-b px-3 py-2 last:border-b-0">
      <label
        className={
          choice === undefined
            ? "text-muted-foreground min-w-0 flex-1 truncate"
            : "min-w-0 flex-1 truncate"
        }
        htmlFor={id}
      >
        {name}
      </label>
      {choice === undefined ? (
        <NeverBadge />
      ) : (
        <Badge
          className="cursor-pointer"
          onClick={() => {
            onRead(!choice.read);
          }}
          render={
            <button
              aria-label={
                choice.read
                  ? t`${name} reads only. Change to Write`
                  : t`${name} may write. Change to Read`
              }
              type="button"
            />
          }
          variant={choice.read ? "outline" : "secondary"}
        >
          {choice.read ? (
            <EyeIcon data-icon="inline-start" />
          ) : (
            <PenLineIcon data-icon="inline-start" />
          )}
          {choice.read ? (
            <Trans context="what a tool may do">Read</Trans>
          ) : (
            <Trans context="what a tool may do">Write</Trans>
          )}
        </Badge>
      )}
      <Switch
        checked={choice !== undefined}
        id={id}
        onCheckedChange={onAllow}
      />
    </li>
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
        onClose={onClose}
        onStart={() => {
          void start();
        }}
      >
        <Trans>Sign in to {app}</Trans>
      </Actions>
      <ErrorText>{failure}</ErrorText>
    </>
  );
  if (again !== undefined || !isAdmin(identity.role)) {
    return (
      <ol className="flex flex-col">
        <Step last n={1} state="active" title={t`Sign in`}>
          {signIn}
        </Step>
      </ol>
    );
  }
  return (
    <ol className="flex flex-col">
      <Step n={1} state={chose ? "done" : "active"} title={t`Who uses it`}>
        <ScopeChoice
          onScope={(chosen) => {
            setScope(chosen);
            setChose(true);
          }}
          scope={scope}
        />
      </Step>
      <Step last n={2} state={chose ? "active" : "idle"} title={t`Sign in`}>
        {signIn}
      </Step>
    </ol>
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
  return (
    <ol className="flex flex-col">
      <Step
        n={1}
        state={allowed.length === 0 ? "active" : "done"}
        title={t`What Grasp may do`}
      >
        <p className="text-muted-foreground">
          <Trans>
            A tool switched on starts as Read where Composio says it only reads;
            Grasp doesn&apos;t check that. A Read tool runs without asking. A
            call of a Write tool from chat, or from a person using a domain,
            waits for that person to confirm it; a workflow&apos;s run makes it
            as one of its steps. Press a tool&apos;s badge to change it. Mark a
            tool Read only if it changes nothing: marked wrongly, it changes
            things without asking.
          </Trans>
        </p>
        {listed === undefined ? <LoadingLines /> : null}
        <ErrorText>
          {listed === undefined ? undefined : notLoadedText(listed, i18n)}
        </ErrorText>
        {tools === undefined ? null : (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">
              <Trans>Tools to allow</Trans>
            </legend>
            <ul className="flex max-h-64 flex-col overflow-y-auto rounded-lg border">
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
            </ul>
          </fieldset>
        )}
      </Step>
      <Step
        last
        n={2}
        state={allowed.length === 0 ? "idle" : "active"}
        title={t`Consent and sign in`}
      >
        {/* The consent stays as written: core keeps a hash of the exact
            text consented to (connection-list.tsx shows it again). */}
        <blockquote className="text-muted-foreground border-l-2 pl-3">
          {composioConsentText}
        </blockquote>
        <SignInSteps app={app} />
        <Actions
          app={app}
          attempt={attempt}
          busy={busy}
          disabled={allowed.length === 0}
          onClose={onClose}
          onStart={() => {
            void connect();
          }}
        >
          <Trans>Consent and connect</Trans>
        </Actions>
        <ErrorText>{failure}</ErrorText>
      </Step>
    </ol>
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
      <DialogContent
        className="max-h-svh overflow-y-auto sm:max-w-md"
        closeLabel={t`Close`}
      >
        <header className="flex flex-col gap-3">
          <AppLogo logo={integration.logo} name={app} size="sm" />
          <div className="flex flex-col gap-1">
            <DialogTitle>
              {again === undefined
                ? t`Connect ${app}`
                : t`Sign in to ${app} again`}
            </DialogTitle>
            <DialogDescription>
              {integration.source === "native"
                ? t`Through Grasp's own connector, which keeps the access in your deployment. Your workflows can use it once it is connected, only for what you allow.`
                : t`Through Composio, which keeps the access in its own cloud. Your workflows can use it once it is connected, only for what you allow.`}
            </DialogDescription>
          </div>
        </header>
        {/* Only while open, so each opening starts from its first step. */}
        {open && integration.source === "native" ? (
          <NativeFlow
            again={again}
            identity={identity}
            integration={integration}
            returnTo={returnTo ?? returnToOf(integration.key)}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
        {open && integration.source === "composio" ? (
          <ComposioFlow
            integration={integration}
            returnTo={returnTo ?? returnToOf(integration.key)}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
