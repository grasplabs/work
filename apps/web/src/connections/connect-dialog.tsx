import {
  canSignInAgain,
  composioConsentText,
  composioKeyConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type {
  CatalogTool,
  ConnectionScope,
  ListedConnection,
  OAuthProvider,
  ToolkitKeyField,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input, SecretInput } from "@grasp-os/ui/components/input";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { AppLogo } from "./app-logo.tsx";
import type { Integration } from "./integrations.ts";
import { calendlyTools } from "./permissions/calendly-tools.ts";
import { sortTools, startingChoice } from "./permissions/model.ts";
import type { SortedTool } from "./permissions/model.ts";
import { TrustLine, useTallyWords } from "./permissions/parts.tsx";
import { PermissionChoice } from "./permissions/permission-choice.tsx";
import { allowedOf, toolRules } from "./tool-choices.ts";
import type { AllowedTool } from "./tool-choices.ts";

// Connecting an app, in one dialog wherever it opens (onboarding, the
// Integrations page and panel, an app's page): the app's logo and name, what
// happens, the one choice it takes, a trust line, and the main action pinned
// in the footer. A native provider (Microsoft, Google) asks an admin who
// uses it, then signs in. A connector an admin made from a URL is connected
// as a native suite is: signing in at its server, or typing the key it
// takes; one whose server is inside the company's own network only by an
// admin, for everyone. A Composio toolkit asks an admin what Grasp may
// do (`PermissionChoice`), with the consent word for word behind the trust
// line, then signs in, or takes the key typed in here. Signing in again to
// a connection whose access ran out is the same sign-in for its provider and
// scope. Core and connect check every step: the dialog offers only what the
// role can do. The corner's close cancels.

/**
 * Where a flow sends the browser back to: the integration's own page, which
 * says the app is connected again when `again`.
 */
export const returnToOf = (key: string, again = false): string =>
  again ? `/connectors/${key}?again=1` : `/connectors/${key}`;

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
 * a native provider or a connector made from a URL for anyone, a Composio
 * toolkit and a connector reached through the company network for admins
 * (connect takes only a shared connection there, which only admins make).
 */
export const canConnect = (
  integration: Integration,
  identity: Identity
): boolean => {
  if (identity.staff || !integration.offered || integration.auth === "own") {
    return false;
  }
  if (integration.companyNetwork !== undefined) {
    return isAdmin(identity.role);
  }
  if (integration.source === "native") {
    return oauthProviderSchema.safeParse(integration.id).success;
  }
  return integration.source === "connector" || isAdmin(identity.role);
};

/** Whether an admin connects it for this person: they can't connect it, and they aren't one of the organization's admins. */
export const waitsForAdmin = (
  integration: Integration,
  identity: Identity
): boolean => !canConnect(integration, identity) && !isMemberAdmin(identity);

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
  title: { display: "flex", alignItems: "center", gap: space[3] },
  body: { display: "grid", gap: space[4] },
  part: { display: "grid", gap: space[2] },
  // What the choice adds up to gives way to the button: one line, cut short.
  foot: {
    overflow: "hidden",
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 0,
    alignSelf: "center",
  },
  waiting: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space[2],
  },
});

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
  // Closed, the dialog's attempts count no more: one that answers later
  // neither sends the browser away nor says it failed.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  const begin = async (
    action: (session: Session) => Promise<{ url: string }>
  ): Promise<void> => {
    newest.current += 1;
    const mine = newest.current;
    const current = (): boolean => !closed.current && newest.current === mine;
    setAttempt(mine);
    setBusy(true);
    setFailure(undefined);
    try {
      const started = await core.withSession(action);
      if (current()) {
        // Still busy: the browser leaves for the provider.
        goTo(started);
      }
    } catch (error) {
      if (current()) {
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
 * While core starts the sign-in: a spinner and, once it takes long, a way
 * to try again. Trying again is held to what the dialog's button is: with
 * every tool switched off meanwhile, there is nothing to start.
 */
const Starting = ({
  app,
  disabled,
  onRetry,
}: {
  app: string;
  disabled: boolean;
  /** Trying again; none offered without it. */
  onRetry: (() => void) | undefined;
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
    <div {...stylex.props(styles.waiting)}>
      {long && onRetry !== undefined ? (
        <Button disabled={disabled} onClick={onRetry} size="xs" variant="ghost">
          {t`Taking long? Try again`}
        </Button>
      ) : null}
      <output {...stylex.props(styles.waiting)}>
        <Spinner aria-hidden />
        <Text as="span" size="sm">
          {t`Waiting for ${app}`}
        </Text>
      </output>
    </div>
  );
};

/** The dialog's main action; while core starts the sign-in, the waiting row instead. */
const MainAction = ({
  app,
  attempt,
  busy,
  disabled = false,
  retries = true,
  onStart,
  children,
}: {
  app: string;
  /** Which attempt is waiting: each starts the waiting row over. */
  attempt: number;
  busy: boolean;
  disabled?: boolean;
  /**
   * Whether a start that takes long may be tried again meanwhile. Not
   * where each start makes something of its own, which the first, still
   * under way, would make too.
   */
  retries?: boolean;
  onStart: () => void;
  children: ReactNode;
}) =>
  // Each state its own key, so the one that comes in arrives anew (and
  // each attempt's waiting row starts over), rather than swapping in place.
  busy ? (
    <div
      data-slot="fade-in"
      key={`starting-${attempt}`}
      {...stylex.props(fadeIn)}
    >
      <Starting
        app={app}
        disabled={disabled}
        onRetry={retries ? onStart : undefined}
      />
    </div>
  ) : (
    <Button
      data-slot="fade-in"
      disabled={disabled}
      key="ready"
      onClick={onStart}
    >
      {children}
    </Button>
  );

/** The dialog's parts: its head, the body that scrolls, and the footer that stays. */
const Parts = ({
  integration,
  title,
  description,
  children,
  failure,
  trust,
  foot,
  action,
}: {
  integration: Integration;
  title: string;
  description: string;
  children?: ReactNode;
  /** Why something failed, over the trust line. */
  failure: string | undefined;
  trust: ReactNode;
  /** A line beside the action, such as what the choice adds up to. */
  foot?: string;
  action: ReactNode;
}) => (
  <>
    <DialogHeader>
      <div {...stylex.props(styles.title)}>
        <AppLogo logo={integration.logo} name={integration.name} size="sm" />
        <DialogTitle>{title}</DialogTitle>
      </div>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
    <DialogBody>
      <div {...stylex.props(styles.body)}>
        {children}
        {failure === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>{failure}</AlertTitle>
          </Alert>
        )}
        {trust}
      </div>
    </DialogBody>
    <DialogFooter>
      <span {...stylex.props(styles.foot)}>
        {foot === undefined ? null : (
          <Text as="span" color="muted" size="sm" truncate>
            {foot}
          </Text>
        )}
      </span>
      {action}
    </DialogFooter>
  </>
);

/**
 * Where a native provider's sign-in page is, shown as the prototype shows
 * it: the host connect sends the browser to (apps/connect/src/providers.ts).
 */
const signInHosts: Readonly<Record<OAuthProvider, string>> = {
  microsoft: "login.microsoftonline.com",
  google: "accounts.google.com",
};

/**
 * The sign-in host of `integration`: a native provider's, or the one the
 * catalog names for a connector made from a URL, as any public host can
 * draw a look-alike sign-in page.
 */
export const signInHostOf = (integration: Integration): string | undefined => {
  if (integration.source === "connector") {
    return integration.signInHost;
  }
  if (integration.source !== "native") {
    return undefined;
  }
  const provider = oauthProviderSchema.safeParse(integration.id);
  return provider.success ? signInHosts[provider.data] : undefined;
};

/** An admin's choice: connect for themselves, or for everyone, on one control. */
const ScopeChoice = ({
  scope,
  onScope,
}: {
  scope: ConnectionScope;
  onScope: (scope: ConnectionScope) => void;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.part)}>
      <Text as="span" size="sm" weight="medium">
        {t`Who uses it`}
      </Text>
      <ToggleGroup
        aria-label={t`Who uses it`}
        fullWidth
        onValueChange={(value) => {
          const [next] = value;
          if (next === "personal" || next === "shared") {
            onScope(next);
          }
        }}
        size="sm"
        value={[scope]}
      >
        <ToggleGroupItem value="personal">{t`Just for you`}</ToggleGroupItem>
        <ToggleGroupItem value="shared">{t`For the company`}</ToggleGroupItem>
      </ToggleGroup>
      <Text color="muted" size="xs">
        {scope === "shared"
          ? t`Nobody uses it in chat until you choose who may, and Apps and workflows only through the permissions you grant.`
          : t`Only you can use it.`}
      </Text>
    </div>
  );
};

/**
 * The key a connector's server takes, typed in here and never shown: it
 * stays in this form until it goes to core, and the form never submits
 * itself (Enter connects, through `onSubmit`), so it never reaches an
 * address or the history.
 */
const KeyEntry = ({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) => {
  const { t } = useLingui();
  return (
    <form
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && value !== "") {
          onSubmit();
        }
      }}
      {...stylex.props(styles.part)}
    >
      <Field>
        <FieldLabel>{t`Key`}</FieldLabel>
        <SecretInput
          disabled={disabled}
          onValueChange={onChange}
          required
          spellCheck={false}
          value={value}
        />
      </Field>
    </form>
  );
};

/**
 * Signing in to a native provider or a connector made from a URL: who uses
 * it (an admin chooses), then signing in, or typing the key a connector's
 * server takes. A connector reached through the company network is shared
 * only, so there is nothing to choose.
 */
const NativeConnect = ({
  integration,
  identity,
  again,
  returnTo,
}: {
  integration: Integration;
  identity: Identity;
  /** The connection to sign in to again, keeping its scope. */
  again: ListedConnection | undefined;
  returnTo: string;
}) => {
  const { attempt, begin, busy, failure } = useSignInStart();
  const { t } = useLingui();
  const address = integration.companyNetwork;
  const [scope, setScope] = useState<ConnectionScope>(
    again?.scope ?? (address === undefined ? "personal" : "shared")
  );
  const [key, setKey] = useState("");
  const withKey = integration.auth === "key";
  const app = integration.name;
  const host = signInHostOf(integration);
  const start = async (): Promise<void> => {
    await begin(async (session) =>
      withKey
        ? await session.connections.connectWithKey({
            provider: integration.id,
            scope,
            key,
            returnTo,
          })
        : await session.connections.start({
            provider: integration.id,
            scope,
            returnTo,
          })
    );
  };
  // Why it is connected as it is: through the company's network, once for
  // everyone; with the key its server takes; or by signing in.
  const description = (): string => {
    if (again !== undefined) {
      return t`Its access ran out. Sign in again to keep it working.`;
    }
    if (address !== undefined) {
      return t({
        message: `Grasp reaches it through your company network at ${address}. It is connected once, for everyone: your organization uses it through the permissions you grant.`,
        comment:
          "{address} is the server's address inside the company's network, e.g. http://10.0.0.8:8080.",
      });
    }
    return withKey
      ? t`Through ${app}'s own MCP server, which carries out what you allow. Grasp keeps the access in your deployment, and your workflows can use it once it is connected.`
      : t`Sign in at ${app} to connect it. It takes about a minute.`;
  };
  const trust = (): string => {
    if (withKey) {
      return t`The key its server takes. Grasp keeps it sealed and never shows it again.`;
    }
    return host === undefined
      ? t`You sign in on ${app}’s own page. The access stays in your deployment, and Grasp uses it only for what you allow.`
      : t({
          message: `You sign in at ${host}. The access stays in your deployment, and Grasp uses it only for what you allow.`,
          comment:
            "{host} is the web address of the sign-in page, e.g. login.microsoftonline.com.",
        });
  };
  return (
    <Parts
      action={
        <MainAction
          app={app}
          attempt={attempt}
          busy={busy}
          disabled={withKey && key === ""}
          onStart={() => {
            void start();
          }}
          retries={!withKey}
        >
          {withKey ? t`Connect ${app}` : t`Sign in to ${app}`}
        </MainAction>
      }
      description={description()}
      failure={failure}
      integration={integration}
      title={
        again === undefined ? t`Connect ${app}` : t`Sign in to ${app} again`
      }
      trust={<TrustLine words={trust()} />}
    >
      {again === undefined &&
      address === undefined &&
      isAdmin(identity.role) ? (
        <ScopeChoice onScope={setScope} scope={scope} />
      ) : null}
      {withKey ? (
        <KeyEntry
          disabled={busy}
          onChange={setKey}
          onSubmit={() => {
            void start();
          }}
          value={key}
        />
      ) : null}
    </Parts>
  );
};

/**
 * What an admin types to connect a toolkit with a key, as Composio
 * describes each field: a secret one as a password, never filled back in.
 * The values stay in this form until they go to core, and the form never
 * submits by itself, so they never reach an address or the history.
 */
const KeyFields = ({
  fields,
  values,
  disabled,
  onChange,
}: {
  fields: readonly ToolkitKeyField[];
  values: Readonly<Record<string, string>>;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <form
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
      }}
      {...stylex.props(styles.part)}
    >
      {fields.map(({ name, label, description, required, secret }) => (
        <Field key={name}>
          <FieldLabel>{required ? label : t`${label} (optional)`}</FieldLabel>
          <Input
            autoComplete="off"
            disabled={disabled}
            onValueChange={(value) => {
              onChange(name, value);
            }}
            required={required}
            secret={secret}
            spellCheck={false}
            type={secret ? "password" : "text"}
            value={values[name] ?? ""}
          />
          {description === null ? null : (
            <FieldDescription>{description}</FieldDescription>
          )}
          <FieldError match="valueMissing">{t`Fill in ${label}.`}</FieldError>
        </Field>
      ))}
    </form>
  );
};

/**
 * Disconnects the connections a toolkit's new one replaces, first:
 * Composio's account can't be signed in to again, and the same account
 * can't be connected twice.
 */
const disconnectReplaced = async (
  session: Session,
  replacing: readonly ListedConnection[]
): Promise<void> => {
  await Promise.all(
    replacing.map(async ({ id }) => await session.connections.disconnect(id))
  );
};

/**
 * A toolkit's tools, sorted. Where core can't list Calendly's tools in
 * development, its tools as Composio's catalog lists them stand in.
 */
const useSortedTools = (
  integration: Integration
): {
  sorted: SortedTool[] | undefined;
  failure: string | undefined;
  sample: boolean;
} => {
  const { i18n } = useLingui();
  const { source, id } = integration;
  const core = useCore();
  const [listed, setListed] = useState<Loaded<CatalogTool[]>>();
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
  const sample =
    import.meta.env.DEV &&
    listed !== undefined &&
    listed.state !== "ready" &&
    id === "calendly";
  const tools = listed?.state === "ready" ? listed.data : undefined;
  const sorted = useMemo(() => {
    const shown: readonly CatalogTool[] | undefined =
      tools ?? (sample ? calendlyTools : undefined);
    return shown === undefined ? undefined : sortTools(shown, id);
  }, [tools, sample, id]);
  const failure =
    listed === undefined || listed.state === "ready" || sample
      ? undefined
      : (notLoadedText(listed, i18n) ?? undefined);
  return { sorted, failure, sample };
};

/** The fields a toolkit that takes a key asks for; none read for one that signs in. */
const useKeyFields = (
  id: string,
  key: boolean
): Loaded<ToolkitKeyField[]> | undefined => {
  const core = useCore();
  const [loaded, setLoaded] = useState<Loaded<ToolkitKeyField[]>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const answer = await loadFromCore(
        core,
        async (session) => await session.connections.keyFields(id),
        left.signal
      );
      if (!left.signal.aborted) {
        setLoaded(answer);
      }
    };
    if (key) {
      void read();
    }
    return () => {
      left.abort();
    };
  }, [core, id, key]);
  return loaded;
};

/** A key toolkit's fields, what is typed in them, and whether every one it needs is filled. */
const useKeyEntry = (id: string, key: boolean) => {
  const { i18n } = useLingui();
  const loaded = useKeyFields(id, key);
  const [values, setValues] = useState<Record<string, string>>({});
  const fields = loaded?.state === "ready" ? loaded.data : undefined;
  const filled =
    !key ||
    fields?.every(
      ({ name, required }) => !required || (values[name] ?? "") !== ""
    ) === true;
  const failure =
    loaded === undefined || loaded.state === "ready"
      ? undefined
      : (notLoadedText(loaded, i18n) ?? undefined);
  const handleChange = (name: string, value: string): void => {
    setValues((current) => ({ ...current, [name]: value }));
  };
  return {
    fields,
    values,
    filled,
    failure,
    loading: key && loaded === undefined,
    handleChange,
  };
};

/**
 * Where a toolkit's choice starts: what `from`, a connection that stopped
 * working, allowed of what the toolkit still lists, each tool keeping the
 * resource it was held to; otherwise every tool that only looks.
 */
const startOf = (
  sorted: readonly SortedTool[],
  from: ListedConnection | undefined
): AllowedTool[] => {
  if (from === undefined) {
    return startingChoice(sorted);
  }
  const listed = new Set(sorted.map(({ tool }) => tool.name));
  return allowedOf(from).filter(({ name }) => listed.has(name));
};

/**
 * Connecting a Composio toolkit, for an admin: what Grasp may do, the
 * consent as written behind the trust line, then signing in, or, for one
 * that takes a key, the key typed in here. A Read tool runs without asking;
 * a call of any other waits for its person to confirm it wherever a person
 * is there (chat, an App they use), and a workflow's run makes it as a step.
 */
const ToolkitConnect = ({
  integration,
  replacing,
  startFrom,
  returnTo,
}: {
  integration: Integration;
  replacing: readonly ListedConnection[];
  startFrom: ListedConnection | undefined;
  returnTo: string;
}) => {
  const { attempt, begin, busy, failure } = useSignInStart();
  const { t } = useLingui();
  const [chosen, setChosen] = useState<AllowedTool[]>();
  const app = integration.name;
  const { id } = integration;
  const key = integration.auth === "key";
  const { sorted, failure: notListed, sample } = useSortedTools(integration);
  const entry = useKeyEntry(id, key);
  const allowed =
    chosen ?? (sorted === undefined ? [] : startOf(sorted, startFrom));
  const tally = useTallyWords(allowed);
  const connect = async (): Promise<void> => {
    await begin(async (session) => {
      await disconnectReplaced(session, replacing);
      // The consent word for word as the dialog holds it: core records its hash.
      return key
        ? await session.connections.connectToolkitWithKey({
            toolkit: id,
            tools: toolRules(allowed),
            consent: composioKeyConsentText,
            values: entry.values,
            returnTo,
          })
        : await session.connections.connectToolkit({
            toolkit: id,
            tools: toolRules(allowed),
            consent: composioConsentText,
            returnTo,
          });
    });
  };
  return (
    <Parts
      action={
        <MainAction
          app={app}
          attempt={attempt}
          busy={busy}
          disabled={allowed.length === 0 || !entry.filled}
          onStart={() => {
            void connect();
          }}
          retries={!key}
        >
          {key ? t`Allow and connect` : t`Allow and sign in`}
        </MainAction>
      }
      description={
        key
          ? t`Choose what Grasp may do in ${app}, then enter its key.`
          : t`Choose what Grasp may do in ${app}, then sign in there.`
      }
      failure={failure ?? notListed ?? entry.failure}
      foot={tally}
      integration={integration}
      title={
        startFrom === undefined ? t`Connect ${app}` : t`Connect ${app} again`
      }
      trust={
        <TrustLine
          consent={key ? composioKeyConsentText : composioConsentText}
          words={
            key
              ? t`Composio keeps the key in its cloud. Grasp uses it only for what you allow.`
              : t`You sign in at ${app}. Composio keeps the access in its cloud, and Grasp uses it only for what you allow.`
          }
        />
      }
    >
      {sample ? (
        <Text color="subtle" size="xs">
          {t`Sample: Calendly's tools as Composio lists them.`}
        </Text>
      ) : null}
      {sorted === undefined && notListed === undefined ? (
        <LoadingLines />
      ) : null}
      {sorted === undefined ? null : (
        <div {...stylex.props(fadeIn)}>
          <PermissionChoice
            allowed={allowed}
            app={app}
            onAllowed={setChosen}
            sorted={sorted}
          />
        </div>
      )}
      {entry.loading ? <LoadingLines /> : null}
      {entry.fields === undefined ? null : (
        <KeyFields
          disabled={busy}
          fields={entry.fields}
          onChange={entry.handleChange}
          values={entry.values}
        />
      )}
    </Parts>
  );
};

const noneReplaced: readonly ListedConnection[] = [];

/**
 * The dialog: connecting `integration`, or signing in again to `again`.
 * Open only for someone `canConnect` or `canReconnect` allows. The flow
 * sends the browser back to `returnTo`: by default the integration's page.
 */
export const ConnectDialog = ({
  integration,
  identity,
  again,
  replacing = noneReplaced,
  startFrom,
  returnTo,
  open,
  onOpenChange,
}: {
  integration: Integration;
  identity: Identity;
  again?: ListedConnection;
  /**
   * A toolkit's key connections that stopped working, disconnected as its
   * new key is added: connect keeps one key connection of a toolkit.
   */
  replacing?: readonly ListedConnection[];
  /**
   * A toolkit's connection that stopped working, which this one is
   * connected again beside: the choice starts from what it allowed.
   */
  startFrom?: ListedConnection;
  returnTo?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent>
      {/* Only while open, so each opening starts afresh. */}
      {open && integration.source !== "composio" ? (
        <NativeConnect
          again={again}
          identity={identity}
          integration={integration}
          returnTo={
            returnTo ?? returnToOf(integration.key, again !== undefined)
          }
        />
      ) : null}
      {open && integration.source === "composio" ? (
        <ToolkitConnect
          integration={integration}
          replacing={replacing}
          returnTo={returnTo ?? returnToOf(integration.key)}
          startFrom={startFrom}
        />
      ) : null}
    </DialogContent>
  </Dialog>
);
