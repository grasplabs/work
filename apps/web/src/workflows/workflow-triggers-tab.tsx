import type {
  ConnectorEventType,
  ListedConnection,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { WorkflowTrigger } from "@grasp-os/shared/workflow-triggers";
import {
  triggerEventsRequest,
  triggerStartRequest,
  workflowWebhookHeaders,
} from "@grasp-os/shared/workflow-triggers";
import { workflowWebhookPath } from "@grasp-os/shared/workflow-webhook-path";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { TabsContent, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Textarea } from "@grasp-os/ui/components/textarea";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CalendarClockIcon,
  MailIcon,
  PlugIcon,
  LinkIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatList } from "../format.ts";
import { CopyButton, ShownOnceDialog } from "../shown-once.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  eventLabels,
  eventTypeOf,
  eventTypes,
  summaryOf,
  triggerDescription,
} from "./trigger-description.ts";

// An independent workflow's Triggers tab (GRA-1303): what starts it on
// its own, as core lists its triggers (`workflowResources.triggers`):
// every one to its builders and the organization's admins, a person's own
// to anyone else. Its builders add a schedule (a cron expression in a time
// zone, with the input each run starts with) or a connection's event (an
// account's new mail or file, with how the event becomes the run's input)
// or an email to an address of its own (with how the message becomes the
// run's input, shown by the part of its address before the @, as an App's
// email trigger is), for an exact published version. A trigger acts for whoever made it:
// they alone turn it on again or move it to another version; its builders
// and admins turn it off and delete it (deleting asks first). A schedule
// whose starts kept failing stopped, and says so, with Turn on again for
// its owner. Core decides every change again (trigger-resources.ts) and
// what it refuses is said where it was asked; nothing starts until an
// admin grants the trigger `start` on the workflow, and a connector
// trigger hears nothing until one grants it its event's read on its
// connection; core asks for both as the trigger is created. Each trigger
// says while it waits for either, and once refused offers to ask again
// for whatever was refused.
//
// A webhook trigger (GRA-1478) takes signed POSTs at a URL of its own:
// the URL shows with a way to copy it to whoever sees the trigger, and
// its secret only once, as core answers it on create or rotate, in a
// dialog kept above the list so reading the list again never takes it
// away. Its owner rotates the secret; whoever manages it revokes it; both
// ask first.

/** The provider whose connections report events of `type`. */
const providerOf = (type: ConnectorEventType): string =>
  type.startsWith("m365.") ? "microsoft" : "google";

/** What starts a run of `trigger`, in words. */
const TriggerWhat = ({
  trigger,
  connections,
}: {
  trigger: WorkflowTrigger;
  connections: readonly ListedConnection[];
}) => {
  const summary = summaryOf(trigger);
  const found = connections.find(
    (each) => each.id === summary.connection?.connectionId
  );
  return triggerDescription(summary, {
    accountName: found?.accountName ?? found?.provider,
    address: trigger.address,
  });
};

/** The kind of trigger's icon. */
const KindIcon = ({ kind }: { kind: WorkflowTrigger["kind"] }) => {
  if (kind === "schedule") {
    return <CalendarClockIcon aria-hidden="true" className="mt-0.5 size-4" />;
  }
  if (kind === "email") {
    return <MailIcon aria-hidden="true" className="mt-0.5 size-4" />;
  }
  if (kind === "webhook") {
    return <LinkIcon aria-hidden="true" className="mt-0.5 size-4" />;
  }
  return kind === "connector" ? (
    <PlugIcon aria-hidden="true" className="mt-0.5 size-4" />
  ) : (
    <ZapIcon aria-hidden="true" className="mt-0.5 size-4" />
  );
};

/**
 * Where `trigger` stands: off, stopped, or when it next starts a run. Off
 * wins: a stopped trigger someone turned off says so, not that it stopped.
 */
const TriggerState = ({ trigger }: { trigger: WorkflowTrigger }) => {
  if (!trigger.enabled) {
    return (
      <Badge variant="outline">
        <Trans context="a trigger that is turned off">Off</Trans>
      </Badge>
    );
  }
  if (trigger.stopped) {
    return (
      <Badge variant="attention">
        <Trans>Stopped</Trans>
      </Badge>
    );
  }
  const next =
    trigger.nextAt === null ? undefined : formatDateTime(trigger.nextAt);
  return next === undefined ? (
    <Badge variant="passed">
      <Trans context="a trigger that is turned on">On</Trans>
    </Badge>
  ) : (
    <span className="text-muted-foreground text-xs">
      <Trans>Next run: {next}</Trans>
    </span>
  );
};

/**
 * Where webhook trigger `token` takes deliveries: on this page's own
 * origin, as core serves both the app and the webhooks.
 */
const webhookUrlOf = (token: string): string =>
  `${globalThis.location.origin}${workflowWebhookPath}/${token}`;

/** How many of a webhook token's last characters name it on the tab. */
const tokenEnding = 4;

/** How a sender signs a delivery, by the headers core reads. */
const SigningNote = () => {
  const headers = formatList(Object.values(workflowWebhookHeaders));
  return (
    <p className="text-muted-foreground text-sm">
      <Trans>
        To start a run, POST its input as JSON to the URL, signed with the
        secret as{" "}
        <a
          className="underline underline-offset-2"
          href="https://www.standardwebhooks.com"
          rel="noopener noreferrer"
          target="_blank"
        >
          Standard Webhooks
        </a>{" "}
        describes, in the headers {headers}. A delivery more than five minutes
        old is refused.
      </Trans>
    </p>
  );
};

/**
 * A confirmation before `onConfirm`, behind a small button. It closes as
 * soon as it is confirmed, and confirms nothing while a change runs, so a
 * second click can't make the change twice (rotating again would end the
 * secret just shown); what goes wrong shows in the row.
 */
const Confirmed = ({
  button,
  label,
  title,
  description,
  confirm,
  busy,
  onConfirm,
}: {
  button: string;
  /** The button's name with the trigger it is for, for screen readers. */
  label: string;
  title: string;
  description: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        aria-label={label}
        disabled={busy}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        {button}
      </Button>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
              variant="destructive"
            >
              {confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/**
 * A webhook trigger's URL, with a way to copy it, whether its secret takes
 * deliveries, and how to sign one; for its owner, a new secret; for
 * whoever manages it, revoking the secret. Both ask first.
 */
const WebhookDetails = ({
  webhook,
  mayRotate,
  mayRevoke,
  busy,
  onRotate,
  onRevoke,
}: {
  webhook: NonNullable<WorkflowTrigger["webhook"]>;
  mayRotate: boolean;
  mayRevoke: boolean;
  busy: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) => {
  const { t } = useLingui();
  const url = webhookUrlOf(webhook.token);
  const revoked = webhook.secret === "revoked";
  // Names this trigger's buttons apart from another webhook's on the tab.
  const ending = webhook.token.slice(-tokenEnding);
  return (
    <div className="flex flex-col gap-2 pl-7">
      <div className="flex min-w-0 items-center gap-2">
        <Input aria-label={t`Webhook URL`} readOnly value={url} />
        <CopyButton
          label={t`Copy the URL of the webhook ending ${ending}`}
          text={url}
        />
      </div>
      {revoked ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="attention">
            <Trans>Secret revoked</Trans>
          </Badge>
          <span className="text-muted-foreground">
            <Trans>
              It takes no delivery until whoever made it makes a new secret.
            </Trans>
          </span>
        </p>
      ) : null}
      <SigningNote />
      {mayRotate || (mayRevoke && !revoked) ? (
        <div className="flex flex-wrap items-center gap-2">
          {mayRotate ? (
            <Confirmed
              busy={busy}
              button={revoked ? t`Make a new secret` : t`Rotate the secret`}
              confirm={revoked ? t`Make a new secret` : t`Rotate the secret`}
              label={
                revoked
                  ? t`Make a new secret for the webhook ending ${ending}`
                  : t`Rotate the secret of the webhook ending ${ending}`
              }
              description={
                revoked
                  ? t`Senders must sign with the new secret, which you see only once.`
                  : t`The current secret stops working at once: senders must sign with the new one, which you see only once.`
              }
              onConfirm={onRotate}
              title={
                revoked
                  ? t`Make a new secret?`
                  : t`Rotate the webhook's secret?`
              }
            />
          ) : null}
          {mayRevoke && !revoked ? (
            <Confirmed
              busy={busy}
              button={t`Revoke the secret`}
              confirm={t`Revoke the secret`}
              label={t`Revoke the secret of the webhook ending ${ending}`}
              description={t`No delivery starts a run until whoever made the trigger makes a new secret.`}
              onConfirm={onRevoke}
              title={t`Revoke the webhook's secret?`}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** A permission a trigger asks an admin for, and where it stands. */
interface Asked {
  what: "start" | "events";
  status: WorkflowTrigger["start"];
}

/** What waiting for, being refused or never asking for `what` means, in words. */
const askedTexts = {
  start: {
    requested: msg`It starts nothing until an admin allows it to start this workflow.`,
    revoked: msg`An admin refused or took back its start: it starts nothing.`,
    never: msg`No admin has been asked to let it start this workflow: it starts nothing until one allows it.`,
  },
  events: {
    requested: msg`It hears nothing until an admin allows it to read these events on its connection.`,
    revoked: msg`An admin refused or took back its reading of these events: it hears nothing.`,
    never: msg`No admin has been asked to let it read these events on its connection: it hears nothing until one allows it.`,
  },
} as const satisfies Record<
  Asked["what"],
  Record<"requested" | "revoked" | "never", MessageDescriptor>
>;

/** Where one of a trigger's permissions that isn't granted stands. */
const AskedLine = ({ what, status }: Asked) => {
  const { t } = useLingui();
  if (status === "requested") {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant="attention">
          <Trans>Waiting for an admin</Trans>
        </Badge>
        {t(askedTexts[what].requested)}
      </span>
    );
  }
  // Never asked (a trigger made before triggers asked as they were
  // created): nobody refused it, so it isn't said to be refused.
  if (status === null) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant="attention">
          <Trans>Not requested yet</Trans>
        </Badge>
        {t(askedTexts[what].never)}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge variant="destructive">
        <Trans>Not allowed</Trans>
      </Badge>
      {t(askedTexts[what].revoked)}
    </span>
  );
};

/**
 * What `trigger` asks an admin for as it is created: to start its
 * workflow, and for a connector trigger to read its event on its
 * connection. Each it holds says nothing; each else says that it waits,
 * was refused or taken back, or was never asked. Whoever manages it may
 * ask again for each refused or never asked, at once (`onAsk`).
 */
const TriggerAccess = ({
  asked,
  manages,
  busy,
  onAsk,
}: {
  asked: readonly Asked[];
  manages: boolean;
  busy: boolean;
  onAsk: () => void;
}) => {
  const open = asked.filter(({ status }) => status !== "active");
  if (open.length === 0) {
    return null;
  }
  const refused = open.some(({ status }) => status === "revoked");
  const askable = open.some(
    ({ status }) => status === "revoked" || status === null
  );
  return (
    <div className="text-muted-foreground flex flex-col gap-2 pl-7 text-sm">
      {open.map(({ what, status }) => (
        <AskedLine key={what} status={status} what={what} />
      ))}
      {manages && askable ? (
        <div>
          <Button disabled={busy} onClick={onAsk} size="sm" variant="outline">
            {refused ? (
              <Trans>Request again</Trans>
            ) : (
              <Trans context="ask an admin to let a trigger start">
                Request
              </Trans>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

/** What `trigger` asks an admin for, and where each stands. */
const askedOf = (trigger: WorkflowTrigger): Asked[] => [
  { what: "start", status: trigger.start },
  ...(trigger.kind === "connector"
    ? [{ what: "events" as const, status: trigger.events }]
    : []),
];

/**
 * The requests that ask again for what `trigger` was refused or never
 * asked for, under the names it asked with as it was created: a refused
 * or revoked one no longer holds them.
 */
const requestsAgain = (trigger: WorkflowTrigger): PermissionRequest[] =>
  askedOf(trigger).flatMap(({ what, status }) => {
    if (status !== "revoked" && status !== null) {
      return [];
    }
    if (what === "start") {
      return [triggerStartRequest(trigger.id, trigger.workflowId)];
    }
    const { connection, event } = summaryOf(trigger);
    const request =
      connection === null || event === null
        ? undefined
        : triggerEventsRequest(
            trigger.id,
            {
              connectionId: connection.connectionId,
              resource: connection.resource ?? undefined,
            },
            event
          );
    return request === undefined ? [] : [request];
  });

/** One trigger: what starts it, its version, where it stands, and what the reader may change. */
const TriggerRow = ({
  trigger,
  connections,
  versions,
  me,
  builder,
  onChanged,
  onSecret,
}: {
  trigger: WorkflowTrigger;
  connections: readonly ListedConnection[];
  versions: readonly number[];
  me: string;
  builder: boolean;
  onChanged: () => Promise<void>;
  /** A webhook trigger's new secret, to show once. */
  onSecret: (secret: string) => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const own = trigger.owner === me;
  const manages = own || builder;
  const { workflowVersion } = trigger;

  const change = async (
    action: (
      triggers: Parameters<
        Parameters<typeof run>[0]
      >[0]["workflowResources"]["triggers"]
    ) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await action(session.workflowResources.triggers);
    });
    // Read again whatever came of it: a change core made can still fail
    // as it reads the trigger back.
    await onChanged();
  };

  const askAgain = async (): Promise<void> => {
    await run(async (session) => {
      for (const request of requestsAgain(trigger)) {
        // oxlint-disable-next-line no-await-in-loop -- one request after another, as an admin sees them
        await session.permissions.request(request);
      }
    });
    await onChanged();
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <KindIcon kind={trigger.kind} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium">
            <TriggerWhat connections={connections} trigger={trigger} />
          </span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <Trans>Starts version {workflowVersion}</Trans>
            <TriggerState trigger={trigger} />
          </span>
          {trigger.stopped ? (
            <span className="text-muted-foreground text-sm">
              <Trans>
                Its runs kept failing to start, so it starts no more until
                whoever made it turns it on again.
              </Trans>
            </span>
          ) : null}
        </span>
      </div>
      <TriggerAccess
        asked={askedOf(trigger)}
        busy={busy}
        manages={manages}
        onAsk={() => {
          void askAgain();
        }}
      />
      {trigger.webhook === null ? null : (
        <WebhookDetails
          busy={busy}
          // Core makes a new secret only for its owner while they build
          // the workflow, and lets whoever manages it revoke one.
          mayRevoke={manages}
          mayRotate={own && builder}
          onRevoke={() => {
            void change(
              async (triggers) => await triggers.revokeWebhookSecret(trigger.id)
            );
          }}
          onRotate={() => {
            void change(async (triggers) => {
              const { secret } = await triggers.rotateWebhookSecret(trigger.id);
              onSecret(secret);
            });
          }}
          webhook={trigger.webhook}
        />
      )}
      {manages ? (
        <div className="flex flex-wrap items-center gap-2 pl-7">
          {/* Turning it on runs it as its owner, so core asks them to
              build the workflow still; turning off and deleting don't. */}
          {own && builder && (trigger.stopped || !trigger.enabled) ? (
            <Button
              disabled={busy}
              onClick={() => {
                void change(
                  async (triggers) =>
                    await triggers.setEnabled(trigger.id, true)
                );
              }}
              size="sm"
              variant="outline"
            >
              {trigger.stopped ? t`Turn on again` : t`Turn on`}
            </Button>
          ) : null}
          {/* A stopped trigger is still on in core: turned off, it stays
              off once someone turns it on again elsewhere. */}
          {trigger.enabled ? (
            <Button
              disabled={busy}
              onClick={() => {
                void change(
                  async (triggers) =>
                    await triggers.setEnabled(trigger.id, false)
                );
              }}
              size="sm"
              variant="outline"
            >
              <Trans context="turn a trigger off">Turn off</Trans>
            </Button>
          ) : null}
          {own && builder && versions.length > 1 ? (
            <NativeSelect
              aria-label={t`Version it starts`}
              disabled={busy}
              onChange={(event) => {
                const next = Number(event.target.value);
                void change(
                  async (triggers) =>
                    await triggers.setVersion(trigger.id, next)
                );
              }}
              size="sm"
              value={String(workflowVersion)}
            >
              {versions.map((version) => (
                <NativeSelectOption key={version} value={String(version)}>
                  {t`Version ${version}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger
              disabled={busy}
              render={<Button size="sm" variant="ghost" />}
            >
              <Trans context="delete a trigger">Delete</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Delete this trigger?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    It starts no more runs. Runs it already started go on. This
                    can&apos;t be undone.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void change(async (triggers) => {
                      await triggers.delete(trigger.id);
                    });
                  }}
                  variant="destructive"
                >
                  <Trans>Delete the trigger</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/** JSON typed into a field, or why it isn't. */
const jsonOf = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
};

/** The person's own time zone, as the browser has it. */
const ownTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The kinds of trigger a builder adds here. */
const addedKinds = ["schedule", "connector", "email", "webhook"] as const;

type AddedKind = (typeof addedKinds)[number];

/**
 * A new trigger, for a builder: a schedule, a connection's event, an email
 * or a signed webhook call, for one version.
 */
const AddTrigger = ({
  workflow,
  versions,
  connections,
  onAdded,
  onSecret,
}: {
  workflow: string;
  versions: readonly number[];
  connections: readonly ListedConnection[];
  onAdded: () => Promise<void>;
  /** A new webhook trigger's secret, to show once. */
  onSecret: (secret: string) => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
  const [problem, setProblem] = useState<string>();
  const [kind, setKind] = useState<AddedKind>("schedule");
  const [chosen, setChosen] = useState(versions.at(-1) ?? 1);
  const [cron, setCron] = useState("");
  const [timeZone, setTimeZone] = useState(ownTimeZone);
  const [input, setInput] = useState("{}");
  const [event, setEvent] = useState<ConnectorEventType>("m365.mail.received");
  const [connection, setConnection] = useState("");
  const [resource, setResource] = useState("");
  const [mapping, setMapping] = useState("{}");
  const reporting = connections.filter(
    (each) =>
      each.source === "native" &&
      each.status === "active" &&
      each.provider === providerOf(event)
  );

  const configOf = (): unknown => {
    // A delivery's body is its run's input, as is: nothing to configure.
    if (kind === "webhook") {
      return {};
    }
    if (kind === "schedule") {
      const parsed = jsonOf(input);
      if (!parsed.ok) {
        setProblem(t`The input isn't JSON.`);
        return undefined;
      }
      return {
        schedule: { cron: cron.trim(), timeZone: timeZone.trim() },
        input: parsed.value,
        missedOccurrences: "coalesce",
      };
    }
    const fields = jsonOf(mapping);
    if (!fields.ok) {
      setProblem(t`The input fields aren't JSON.`);
      return undefined;
    }
    if (kind === "email") {
      return { input: { fields: fields.value, defaults: {} } };
    }
    if (connection === "") {
      setProblem(t`Choose a connection.`);
      return undefined;
    }
    return {
      connection: {
        connectionId: connection,
        ...(resource.trim() === "" ? {} : { resource: resource.trim() }),
      },
      event,
      input: { fields: fields.value, defaults: {} },
    };
  };

  const add = async (): Promise<void> => {
    setProblem(undefined);
    const config = configOf();
    if (config === undefined) {
      return;
    }
    const created = await run(
      async (session) =>
        await session.workflowResources.triggers.create({
          kind,
          workflowId: workflow,
          version: chosen,
          config,
        })
    );
    if (created !== undefined) {
      setCron("");
      setInput("{}");
      setMapping("{}");
    }
    if (created?.secret !== undefined) {
      onSecret(created.secret);
    }
    // Read again however it ended, as the rows' own changes are: a trigger
    // core saved before its answer was lost shows, rather than being added
    // twice on a retry.
    await onAdded();
  };

  return (
    <form
      className="bg-card flex flex-col gap-4 rounded-xl border p-4"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void add();
      }}
    >
      <h3 className="font-medium">
        <Trans>Add a trigger</Trans>
      </h3>
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-kind`}>
            <Trans>What starts it</Trans>
          </Label>
          <NativeSelect
            id={`${ids}-kind`}
            onChange={(changed) => {
              setKind(
                addedKinds.find((each) => each === changed.target.value) ??
                  "schedule"
              );
            }}
            value={kind}
          >
            <NativeSelectOption value="schedule">{t`A schedule`}</NativeSelectOption>
            <NativeSelectOption value="connector">
              {t`An event at a connection`}
            </NativeSelectOption>
            <NativeSelectOption value="email">
              {t`An email to its own address`}
            </NativeSelectOption>
            <NativeSelectOption value="webhook">
              {t`A signed call to its own URL`}
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-version`}>
            <Trans>Version it starts</Trans>
          </Label>
          <NativeSelect
            id={`${ids}-version`}
            onChange={(changed) => {
              setChosen(Number(changed.target.value));
            }}
            value={String(chosen)}
          >
            {versions.map((version) => (
              <NativeSelectOption key={version} value={String(version)}>
                {t`Version ${version}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {kind === "schedule" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-cron`}>
                <Trans>When, as a cron expression</Trans>
              </Label>
              <Input
                id={`${ids}-cron`}
                onChange={(changed) => {
                  setCron(changed.target.value);
                }}
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                value={cron}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-zone`}>
                <Trans>Time zone</Trans>
              </Label>
              <Input
                id={`${ids}-zone`}
                onChange={(changed) => {
                  setTimeZone(changed.target.value);
                }}
                spellCheck={false}
                value={timeZone}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-input`}>
              <Trans>The input each run starts with, as JSON</Trans>
            </Label>
            <Textarea
              id={`${ids}-input`}
              onChange={(changed) => {
                setInput(changed.target.value);
              }}
              spellCheck={false}
              value={input}
              variant="code"
            />
          </div>
        </div>
      ) : null}
      {kind === "email" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-mapping`}>
            <Trans>
              The run&apos;s input fields, each from the message as a JSON
              Pointer, as JSON
            </Trans>
          </Label>
          <Textarea
            id={`${ids}-mapping`}
            onChange={(changed) => {
              setMapping(changed.target.value);
            }}
            placeholder='{ "subject": "/subject", "from": "/from/address", "attachments": "/attachments" }'
            spellCheck={false}
            value={mapping}
            variant="code"
          />
        </div>
      ) : null}
      {kind === "connector" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-event`}>
                <Trans>Event</Trans>
              </Label>
              <NativeSelect
                id={`${ids}-event`}
                onChange={(changed) => {
                  const type = eventTypeOf(changed.target.value);
                  if (type !== undefined) {
                    setEvent(type);
                    setConnection("");
                  }
                }}
                value={event}
              >
                {eventTypes.map((type) => (
                  <NativeSelectOption key={type} value={type}>
                    {t(eventLabels[type])}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-connection`}>
                <Trans>Connection</Trans>
              </Label>
              <NativeSelect
                id={`${ids}-connection`}
                onChange={(changed) => {
                  setConnection(changed.target.value);
                }}
                value={connection}
              >
                <NativeSelectOption value="">{t`Choose…`}</NativeSelectOption>
                {reporting.map((each) => (
                  <NativeSelectOption key={each.id} value={each.id}>
                    {each.accountName ?? each.provider}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-resource`}>
                <Trans>Mailbox or drive, if not the account&apos;s own</Trans>
              </Label>
              <Input
                id={`${ids}-resource`}
                onChange={(changed) => {
                  setResource(changed.target.value);
                }}
                spellCheck={false}
                value={resource}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-mapping`}>
              <Trans>
                The run&apos;s input fields, each from the event as a JSON
                Pointer, as JSON
              </Trans>
            </Label>
            <Textarea
              id={`${ids}-mapping`}
              onChange={(changed) => {
                setMapping(changed.target.value);
              }}
              placeholder='{ "subject": "/payload/subject" }'
              spellCheck={false}
              value={mapping}
              variant="code"
            />
          </div>
        </div>
      ) : null}
      {kind === "webhook" ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            It gets a URL of its own and a secret, which you see only once, as
            it is added. Each signed POST to the URL starts a run, with the body
            as its input.
          </Trans>
        </p>
      ) : null}
      <ErrorText>{problem ?? failure}</ErrorText>
      <div>
        <Button disabled={busy} size="sm" type="submit">
          <Trans>Add the trigger</Trans>
        </Button>
      </div>
    </form>
  );
};

/** What the tab read from core. */
interface Read {
  triggers: WorkflowTrigger[];
  versions: number[];
  connections: ListedConnection[];
  /** Why the connections couldn't be read: its rows name a connection by its id then. */
  connectionsFailure?: string;
}

/**
 * The connections Connect lists, asked only for the accounts' names: when
 * it can't answer, none, and why, so the triggers still show, by
 * connection id.
 */
const accountsOf = async (
  list: () => Promise<ListedConnection[]>
): Promise<Pick<Read, "connections" | "connectionsFailure">> => {
  try {
    return { connections: await list() };
  } catch (error) {
    return { connections: [], connectionsFailure: failureText(error) };
  }
};

/** The tab's own trigger, beside the page's others. */
export const TriggersTabTrigger = () => (
  <TabsTrigger value="triggers">
    <Trans context="tab of a workflow">Triggers</Trans>
  </TabsTrigger>
);

/**
 * Workflow `workflow`'s triggers, read as it mounts and again for each
 * `generation`, which a change asks for with `onChanged`. The list shown
 * stays until the next read is in, so the Add form keeps what was typed.
 */
const TriggersRead = ({
  workflow,
  me,
  builder,
  generation,
  onChanged,
  onSecret,
}: {
  workflow: string;
  me: string;
  builder: boolean;
  generation: number;
  onChanged: () => void;
  onSecret: (secret: string) => void;
}) => {
  const core = useCore();
  const [read, setRead] = useState<Read>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let stopped = false;
    const readAll = async (): Promise<void> => {
      try {
        const [triggers, versions, accounts] = await core.withSession(
          async (session) =>
            await Promise.all([
              session.workflowResources.triggers.list(workflow),
              builder
                ? session.workflowResources.versions(workflow)
                : Promise.resolve([]),
              accountsOf(async () => await session.connections.list()),
            ])
        );
        if (!stopped) {
          setFailure(undefined);
          setRead({
            triggers,
            versions: versions
              .map(({ version }) => version)
              .toSorted((a, b) => a - b),
            ...accounts,
          });
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
        }
      }
    };
    void readAll();
    return () => {
      stopped = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `generation` says when to read again
  }, [builder, core, generation, workflow]);

  const changed = async (): Promise<void> => {
    onChanged();
    await Promise.resolve();
  };

  if (failure !== undefined) {
    return <ErrorText>{failure}</ErrorText>;
  }
  if (read === undefined) {
    return null;
  }
  return (
    <>
      <ErrorText>{read.connectionsFailure}</ErrorText>
      {read.triggers.length === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
          <Trans>Nothing starts it on its own yet.</Trans>
        </p>
      ) : (
        <ul className="bg-card flex flex-col divide-y rounded-xl border">
          {read.triggers.map((trigger) => (
            <TriggerRow
              builder={builder}
              connections={read.connections}
              key={trigger.id}
              me={me}
              onChanged={changed}
              onSecret={onSecret}
              trigger={trigger}
              versions={read.versions}
            />
          ))}
        </ul>
      )}
      {builder && read.versions.length > 0 ? (
        <AddTrigger
          connections={read.connections}
          onAdded={changed}
          onSecret={onSecret}
          versions={read.versions}
          workflow={workflow}
        />
      ) : null}
    </>
  );
};

/** The tab: workflow `workflow`'s triggers, for `me`, who builds it when `builder`. */
export const TriggersTabContent = ({
  workflow,
  me,
  builder,
}: {
  workflow: string;
  me: string;
  builder: boolean;
}) => {
  // One more each time a change asks for the triggers to be read again.
  const [generation, setGeneration] = useState(0);
  // A webhook trigger's secret as core just answered it: kept here, above
  // the list, so reading it again never takes the secret away unseen.
  const [secret, setSecret] = useState<string>();
  return (
    <TabsContent value="triggers">
      <ShownOnceDialog
        description={
          <Trans>
            Senders sign every delivery with it, so Grasp can tell a call is
            theirs.
          </Trans>
        }
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
        title={<Trans>The webhook&apos;s secret</Trans>}
      />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-6 pb-8">
        <p className="text-muted-foreground">
          <Trans>
            A trigger starts a run on its own, as whoever made it. Adding one
            asks an admin to allow it to start this workflow, and one on a
            connection to read its events there: it starts nothing until they
            do.
          </Trans>
        </p>
        <TriggersRead
          builder={builder}
          // Read again, as core has them now, after each change.
          generation={generation}
          me={me}
          onChanged={() => {
            setGeneration((current) => current + 1);
          }}
          onSecret={setSecret}
          workflow={workflow}
        />
      </div>
    </TabsContent>
  );
};
