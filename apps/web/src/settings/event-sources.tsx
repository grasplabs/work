import type { AuditPage, AuditRecord } from "@grasp-os/shared/audit-log";
import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import { eventSourceHeaders } from "@grasp-os/shared/event-sources";
import type { EventSource } from "@grasp-os/shared/event-sources";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CodeBlock } from "@grasp-os/ui/components/code-block";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Field, FieldError, FieldLabel } from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { Heading } from "@grasp-os/ui/components/heading";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Snippet } from "@grasp-os/ui/components/snippet";
import { Text } from "@grasp-os/ui/components/text";
import {
  ChevronRightIcon,
  EllipsisIcon,
  Icon,
  LinkIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { ConfirmAction } from "./confirm-action.tsx";
import { RefusedBadge, SourceActivity } from "./event-source-activity.tsx";
import { Failure, SettingsGroup, SettingsStack } from "./section.tsx";

// Settings › Incoming events, for the organization's own admins: the event
// sources outside systems send events to (core's event-sources.ts), one per
// sender ("Stripe", "Shop system"). One compact card, a row per source: its
// name, its secret's state only when it needs someone (revoked), how many
// workflows start on it, its URL to copy and a menu to rotate, revoke or
// delete its secret, each asking first. A source opens in a sheet with
// what it takes to set the sender up, what it received lately
// (event-source-activity.tsx) and the workflows it starts: a row says
// only how many it refused in the last day. A new source is made in two
// steps of one dialog: its name, then what to give the sender, the secret
// shown that once.

const styles = stylex.create({
  rowEnd: { display: "flex", alignItems: "center", gap: space[1] },
  stack: { display: "grid", gap: space[4] },
  part: { display: "grid", gap: space[2] },
});

/**
 * Where source `token` takes deliveries: on this page's own origin, as
 * core serves both the app and the sources.
 */
const urlOf = (token: string): string =>
  `${globalThis.location.origin}${eventSourcePath}/${token}`;

/** The workflows each source starts, by the source's ID. */
export type SourceStarts = Readonly<
  Record<string, readonly { id: string; name: string }[]>
>;

/**
 * The workflows each source starts, as the admin sees them: every workflow's
 * triggers, read once for the page, the webhook ones kept by their source.
 */
export const sourceStartsOf = async (
  core: Pick<CoreConnection, "withSession">
): Promise<Loaded<SourceStarts>> =>
  await loadFromCore(core, async (session) => {
    const workflows = await session.workflowResources.list();
    const triggered = await Promise.all(
      workflows.map(async (workflow) => ({
        workflow,
        triggers: await session.workflowResources.triggers.list(workflow.id),
      }))
    );
    const starts: Record<string, { id: string; name: string }[]> = {};
    for (const { workflow, triggers } of triggered) {
      const sources = new Set(
        triggers.flatMap(({ source }) => (source === null ? [] : [source.id]))
      );
      for (const source of sources) {
        starts[source] = [
          ...(starts[source] ?? []),
          { id: workflow.id, name: workflow.name },
        ];
      }
    }
    return starts;
  });

/**
 * How a sender signs and sends one event, in the shell: the three headers
 * Standard Webhooks names, the signature the base64 HMAC-SHA256 of
 * "<id>.<timestamp>.<body>" keyed with the secret's key (the part after
 * `whsec_`, in base64). With the secret when it is shown; a stand-in
 * otherwise.
 */
const recipeOf = (url: string, secret: string | undefined): string =>
  [
    `SECRET='${secret ?? "whsec_…"}'`,
    `URL='${url}'`,
    `BODY='{"type":"payment.paid","data":{"invoice":"INV-42"}}'`,
    `ID="msg_$(uuidgen)"`,
    "TS=$(date +%s)",
    `KEY=$(printf %s "\${SECRET#whsec_}" | base64 -d | xxd -p -c 256)`,
    `SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$KEY" -binary | base64)`,
    `curl -X POST "$URL" \\`,
    `  -H "content-type: application/json" \\`,
    `  -H "${eventSourceHeaders.id}: $ID" \\`,
    `  -H "${eventSourceHeaders.timestamp}: $TS" \\`,
    `  -H "${eventSourceHeaders.signature}: v1,$SIG" \\`,
    `  --data "$BODY"`,
  ].join("\n");

/** How a sender sends one event: the recipe, to copy. */
const Recipe = ({ url, secret }: { url: string; secret?: string }) => {
  const { t } = useLingui();
  return (
    <CodeBlock language="bash" languageLabel={t`Send one event`}>
      {recipeOf(url, secret)}
    </CodeBlock>
  );
};

/** A change to a source that asks first. */
type SourceChange = "rotate" | "revoke" | "delete";

/** What may be done to a source's secret, and the source itself, each asking first. */
const useSourceChanges = (
  source: EventSource,
  onSecret: (secret: string) => void,
  onChanged: () => Promise<void>
) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState<SourceChange>();
  const revoked = source.delivery?.secret === "revoked";
  const { name } = source;
  const confirmed = async (which: SourceChange): Promise<void> => {
    await run(async (session) => {
      const { sources } = session.workflowResources;
      if (which === "rotate") {
        const { secret } = await sources.rotateSecret(source.id);
        onSecret(secret);
      } else if (which === "revoke") {
        await sources.revokeSecret(source.id);
      } else {
        await sources.delete(source.id);
      }
    });
    // Read again whatever came of it.
    await onChanged();
  };
  const words: Record<
    SourceChange,
    { title: string; description: string; confirm: string }
  > = {
    rotate: revoked
      ? {
          title: t`Make a new secret for ${name}?`,
          description: t`The sender must sign with the new secret, which you see only once.`,
          confirm: t`Make it`,
        }
      : {
          title: t`Rotate the secret of ${name}?`,
          description: t`The current secret stops working at once: the sender must sign with the new one, which you see only once.`,
          confirm: t`Rotate`,
        },
    revoke: {
      title: t`Revoke the secret of ${name}?`,
      description: t`No event from this source starts anything until you make it a new secret.`,
      confirm: t`Revoke`,
    },
    delete: {
      title: t`Delete ${name}?`,
      description: t`Its URL takes nothing more, and no workflow starts on its events. This can't be undone.`,
      confirm: t`Delete the source`,
    },
  };
  const asked = asking === undefined ? undefined : words[asking];
  const confirmation =
    asking === undefined || asked === undefined ? null : (
      <ConfirmAction
        action={async () => {
          await confirmed(asking);
        }}
        description={asked.description}
        errorLabel={t`Failed`}
        label={asked.confirm}
        onOpenChange={(open) => {
          if (!open) {
            setAsking(undefined);
          }
        }}
        open
        title={asked.title}
        variant={asking === "delete" ? "destructive" : "default"}
      />
    );
  return { busy, failure, revoked, handleAsk: setAsking, confirmation };
};

/** A source's menu: rotate or make its secret, revoke it, delete the source. */
const SourceMenu = ({
  name,
  revoked,
  busy,
  onAsk,
}: {
  name: string;
  revoked: boolean;
  busy: boolean;
  onAsk: (change: SourceChange) => void;
}) => {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t`More for ${name}`}
          disabled={busy}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={EllipsisIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={RefreshCwIcon}
          onSelect={() => {
            onAsk("rotate");
          }}
        >
          {revoked ? t`Make a new secret` : t`Rotate the secret`}
        </DropdownMenuItem>
        {revoked ? null : (
          <DropdownMenuItem
            onSelect={() => {
              onAsk("revoke");
            }}
          >
            {t`Revoke the secret`}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={TrashIcon}
          onSelect={() => {
            onAsk("delete");
          }}
          variant="destructive"
        >
          {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** How many workflows a source starts, said in a row; nothing when they couldn't be read. */
const useStartsLine = (count: number | undefined): string | undefined => {
  const { t } = useLingui();
  if (count === undefined) {
    return undefined;
  }
  return count === 0
    ? t`Starts no workflow yet`
    : t`${plural(count, { one: "Starts # workflow", other: "Starts # workflows" })}`;
};

/** One source: its name, its state when it needs someone, how many workflows it starts, its URL to copy, its menu. */
const SourceRow = ({
  source,
  starts,
  onOpen,
  onSecret,
  onChanged,
}: {
  source: EventSource;
  starts: number | undefined;
  onOpen: () => void;
  onSecret: (secret: string) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const changes = useSourceChanges(source, onSecret, onChanged);
  const { name } = source;
  const url =
    source.delivery === null ? undefined : urlOf(source.delivery.token);
  const line = useStartsLine(starts);
  return (
    <Item size="xs">
      <ItemMedia variant="icon">
        <Icon icon={LinkIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {name}{" "}
          {changes.revoked ? (
            <Badge size="sm" variant="warning">{t`Secret revoked`}</Badge>
          ) : null}
          <RefusedBadge source={source} />
        </ItemTitle>
        {line === undefined ? null : <ItemDescription>{line}</ItemDescription>}
        <Failure>{changes.failure}</Failure>
      </ItemContent>
      <ItemActions>
        <div {...stylex.props(styles.rowEnd)}>
          {url === undefined ? null : (
            <CopyButton aria-label={t`Copy the URL of ${name}`} value={url} />
          )}
          <Button
            aria-label={t`Details of ${name}`}
            onClick={onOpen}
            size="icon-sm"
            variant="ghost"
          >
            <Icon icon={ChevronRightIcon} />
          </Button>
          <SourceMenu
            busy={changes.busy}
            name={name}
            onAsk={changes.handleAsk}
            revoked={changes.revoked}
          />
        </div>
        {changes.confirmation}
      </ItemActions>
    </Item>
  );
};

/** The runs a source started, as the audit log keeps them: its newest first. */
interface StartedRun {
  workflowId: string;
  at: string;
}

/** The newest runs at most to show. */
const runsShown = 10;

/** The run a record says source `sourceId` started, if it is one. */
const runOf = (record: AuditRecord, sourceId: string): StartedRun[] => {
  const { event } = record;
  const workflowId = event?.target?.id;
  if (workflowId === undefined || event?.detail?.source !== sourceId) {
    return [];
  }
  return [{ workflowId, at: record.receivedAt }];
};

/**
 * The runs source `sourceId` started, read from the audit log's
 * `workflow.start.admitted` events, newest first, a few stretches of it
 * at most.
 */
const startedRuns = async (
  core: Pick<CoreConnection, "withSession">,
  sourceId: string
): Promise<StartedRun[]> =>
  await core.withSession(async ({ audit }) => {
    const runs: StartedRun[] = [];
    let next: number | null = null;
    // A few stretches at most per look: each page reads a bounded part of the log.
    for (let page = 0; page < 5 && runs.length < runsShown; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
      const read: AuditPage = await audit.search(
        { action: "workflow.start.admitted" },
        next ?? undefined
      );
      runs.push(...read.records.flatMap((record) => runOf(record, sourceId)));
      ({ next } = read);
      if (next === null) {
        break;
      }
    }
    return runs.slice(0, runsShown);
  });

/** What reading a source's runs came to. */
type RunsRead =
  | { state: "reading" }
  | { state: "read"; runs: StartedRun[] }
  | { state: "failed" };

/**
 * Reads the runs source `sourceId` started into `onRead`, while `current`
 * is live. Outside the component, as the React Compiler can't compile `try`.
 */
const readRuns = async (
  core: Pick<CoreConnection, "withSession">,
  sourceId: string,
  current: { live: boolean },
  onRead: (read: RunsRead) => void
): Promise<void> => {
  let read: RunsRead;
  try {
    read = { state: "read", runs: await startedRuns(core, sourceId) };
  } catch {
    read = { state: "failed" };
  }
  if (current.live) {
    onRead(read);
  }
};

/** The runs source `sourceId` started, newest first, read as it opens. */
const useRecentRuns = (sourceId: string): RunsRead => {
  const core = useCore();
  const [read, setRead] = useState<RunsRead>({ state: "reading" });
  useEffect(() => {
    const current = { live: true };
    void readRuns(core, sourceId, current, setRead);
    return () => {
      current.live = false;
    };
  }, [core, sourceId]);
  return read;
};

/** One part of an opened source: its name over what it holds. */
const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <section {...stylex.props(styles.part)}>
    <Heading level={3} size="2xs">
      {title}
    </Heading>
    {children}
  </section>
);

/**
 * A source, opened in a sheet: what the sender needs (its URL, its
 * secret's state and how to sign with it), what it received, and the
 * workflows it starts.
 */
const SourceDetails = ({
  source,
  starts,
  onSecret,
  onChanged,
}: {
  source: EventSource;
  starts: readonly { id: string; name: string }[] | undefined;
  onSecret: (secret: string) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const changes = useSourceChanges(source, onSecret, onChanged);
  const runs = useRecentRuns(source.id);
  const url =
    source.delivery === null ? undefined : urlOf(source.delivery.token);
  const names = new Map(
    (starts ?? []).map((workflow) => [workflow.id, workflow.name])
  );
  const openWorkflow = (workflow: string, runsView: boolean): void => {
    void navigate({
      to: "/workflows/$workflow",
      params: { workflow },
      ...(runsView ? { search: { view: "runs" as const } } : {}),
    });
  };
  return (
    <div {...stylex.props(styles.stack)}>
      <Part title={t`Setup`}>
        <Text color="muted" size="sm">
          {t`What the sender needs: the URL, and the secret it signs with.`}
        </Text>
        {url === undefined ? null : (
          <Snippet aria-label={t`Copy the URL`} value={url} />
        )}
        {changes.revoked ? (
          <Alert appearance="subtle" variant="warning">
            <AlertDescription>
              {t`The secret is revoked: nothing this source sends starts a workflow until you make it a new one.`}
            </AlertDescription>
          </Alert>
        ) : null}
        {url === undefined ? null : <Recipe url={url} />}
        <div>
          <Button
            onClick={() => {
              changes.handleAsk("rotate");
            }}
            size="sm"
            variant="outline"
          >
            {changes.revoked ? t`Make a new secret` : t`Rotate the secret`}
          </Button>
        </div>
        <Failure>{changes.failure}</Failure>
      </Part>
      {/* What it received, while core keeps a record of it. */}
      {source.activity === null ? null : (
        <Part title={t`Events`}>
          <SourceActivity source={source} />
        </Part>
      )}
      <Part title={t`Workflows it starts`}>
        {starts !== undefined && starts.length > 0 ? (
          <ItemGroup aria-label={t`Workflows it starts`}>
            {starts.map((workflow) => (
              <Item
                key={workflow.id}
                onClick={() => {
                  openWorkflow(workflow.id, false);
                }}
                size="xs"
              >
                <ItemMedia variant="icon">
                  <Icon icon={WorkflowIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{workflow.name}</ItemTitle>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <Text color="muted" size="sm">
            {starts === undefined
              ? t`The workflows couldn't be read.`
              : t`None yet: a workflow starts on its events from the workflow's Triggers tab.`}
          </Text>
        )}
      </Part>
      <Part title={t`Recent runs`}>
        {runs.state === "read" && runs.runs.length > 0 ? (
          <ItemGroup aria-label={t`Recent runs`}>
            {runs.runs.map((run) => (
              <Item
                key={`${run.workflowId}-${run.at}`}
                onClick={() => {
                  openWorkflow(run.workflowId, true);
                }}
                size="xs"
              >
                <ItemMedia variant="icon">
                  <Icon icon={PlayIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {names.get(run.workflowId) ?? t`A workflow`}
                  </ItemTitle>
                  <ItemDescription>{formatDateTime(run.at)}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <Text color="muted" size="sm">
            {
              {
                reading: t`Reading the runs…`,
                read: t`No run started from it lately.`,
                failed: t`The runs couldn't be read.`,
              }[runs.state]
            }
          </Text>
        )}
      </Part>
      {changes.confirmation}
    </div>
  );
};

/** A secret core answered once, with the warning that it is shown this once. */
const SecretOnce = ({ secret }: { secret: string }) => {
  const { t } = useLingui();
  return (
    <>
      {/* Mounted with each secret, so Copied never carries over. */}
      <Snippet aria-label={t`Copy the secret`} key={secret} value={secret} />
      <Alert appearance="subtle" variant="warning">
        <AlertDescription>
          {t`Copy it now: you won't see it again. Lost, it can only be replaced.`}
        </AlertDescription>
      </Alert>
    </>
  );
};

/**
 * A new source, in two steps of one dialog: its name, after its sender;
 * then what to give the sender, the secret shown this once. Kept mounted
 * above the list, so a read of the list after it, failed or empty, never
 * takes the secret away.
 */
const AddSource = ({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ url: string; secret: string }>();
  const close = (): void => {
    onOpenChange(false);
    setName("");
    setMade(undefined);
  };
  const add = async (): Promise<void> => {
    const created = await run(
      async (session) =>
        await session.workflowResources.sources.create({ name: name.trim() })
    );
    if (created !== undefined) {
      const token = created.source.delivery?.token;
      setMade({
        url: token === undefined ? "" : urlOf(token),
        secret: created.secret,
      });
    }
    await onChanged();
  };
  return (
    <Dialog
      dismissible={made === undefined}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open={open}
    >
      {made === undefined ? (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Add a source`}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Form
              aria-label={t`Add a source`}
              id="new-source"
              onSubmit={(submitted) => {
                submitted.preventDefault();
                void add();
              }}
            >
              <Field data-invalid={failure !== undefined}>
                <FieldLabel>{t`Name`}</FieldLabel>
                <Input
                  maxLength={80}
                  onValueChange={setName}
                  placeholder="Stripe"
                  required
                  value={name}
                />
                <FieldError match="valueMissing">
                  {t`Enter a name for the sender.`}
                </FieldError>
                <FieldError match>{failure}</FieldError>
              </Field>
            </Form>
          </DialogBody>
          <DialogFooter>
            <DialogClose>{t`Cancel`}</DialogClose>
            <Button disabled={busy} form="new-source" size="sm" type="submit">
              {t`Next`}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Give this to the sender`}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <SettingsStack>
              <Snippet aria-label={t`Copy the URL`} value={made.url} />
              <SecretOnce secret={made.secret} />
              <Recipe secret={made.secret} url={made.url} />
            </SettingsStack>
          </DialogBody>
          <DialogFooter>
            <DialogClose variant="default">{t`Done`}</DialogClose>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
};

/**
 * A secret core answered once on a rotation: shown with the way to copy it,
 * until it is closed on purpose.
 */
const SecretDialog = ({
  secret,
  onClose,
}: {
  secret: string | undefined;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Dialog
      dismissible={false}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={secret !== undefined}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`The new secret`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <SettingsStack>
            {secret === undefined ? null : <SecretOnce secret={secret} />}
          </SettingsStack>
        </DialogBody>
        <DialogFooter>
          <DialogClose variant="default">{t`Done`}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The organization's event sources, for an admin, as their list's read
 * came to (`page`), with the workflows each starts (`starts`): the list, or
 * why it couldn't be read, in its place.
 */
export const EventSourcesSettings = ({
  page,
  starts,
}: {
  page: Loaded<readonly EventSource[]>;
  starts: Loaded<SourceStarts>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const [secret, setSecret] = useState<string>();
  const [opened, setOpened] = useState<string>();
  const [adding, setAdding] = useState(false);
  const addButton = (
    <Button
      onClick={() => {
        setAdding(true);
      }}
      size="xs"
      variant="secondary"
    >
      <Icon icon={PlusIcon} />
      {t`Add a source`}
    </Button>
  );
  const changed = async (): Promise<void> => {
    await router.invalidate({ sync: true });
  };
  const startsOf = (id: string) =>
    starts.state === "ready" ? (starts.data[id] ?? []) : undefined;
  const sources = page.state === "ready" ? page.data : [];
  const open = sources.find(({ id }) => id === opened);
  return (
    <>
      <SecretDialog
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
      />
      <AddSource onChanged={changed} onOpenChange={setAdding} open={adding} />
      <SettingsGroup
        {...(sources.length > 0 ? { actions: addButton } : {})}
        flush={page.state === "ready" && sources.length > 0}
        title={t`Sources`}
      >
        {page.state === "ready" ? null : (
          <NotLoadedState heading="h3" page={page} />
        )}
        {page.state === "ready" && sources.length === 0 ? (
          <Empty size="sm">
            <EmptyHeader>
              <EmptyDescription>
                {t`Add a source for each system that sends Grasp events.`}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{addButton}</EmptyContent>
          </Empty>
        ) : null}
        {sources.length > 0 ? (
          <ItemGroup aria-label={t`Sources`}>
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                onChanged={changed}
                onOpen={() => {
                  setOpened(source.id);
                }}
                onSecret={setSecret}
                source={source}
                starts={startsOf(source.id)?.length}
              />
            ))}
          </ItemGroup>
        ) : null}
      </SettingsGroup>
      <Sheet
        onOpenChange={(next) => {
          if (!next) {
            setOpened(undefined);
          }
        }}
        open={open !== undefined}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{open?.name ?? ""}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {open === undefined ? null : (
              <SourceDetails
                key={open.id}
                onChanged={changed}
                onSecret={setSecret}
                source={open}
                starts={startsOf(open.id)}
              />
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
};
