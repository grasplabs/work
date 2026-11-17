import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import { eventSourceHeaders } from "@grasp-os/shared/event-sources";
import type { EventSource } from "@grasp-os/shared/event-sources";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useCopy } from "../copy.ts";
import type { CoreConnection } from "../core-connection.ts";
import { formatDateTime } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { CopyField } from "../grasp/copy-field/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "../grasp/empty/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import {
  Copy,
  Edit,
  Link,
  More,
  Play,
  Plus,
  Tick,
  Trash,
  Workflow,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { InspectorPanel } from "../grasp/inspector-panel/index.ts";
import type { InspectorSection } from "../grasp/inspector-panel/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Sheet, SheetContent, SheetTitle } from "../grasp/sheet/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { SectionNotLoaded, SettingsStack } from "./section.tsx";

// Settings › Incoming events, for the organization's own admins: the event
// sources outside systems send events to (core's event-sources.ts), one per
// sender ("Stripe", "Shop system"). One compact card, a row per source: its
// name, its secret's state only when it needs someone (revoked), how many
// workflows start on it, its URL to copy and a menu to rotate, revoke or
// delete its secret, each asking first. A source opens beside the list with
// what it takes to set the sender up, the workflows it starts and the runs
// it started. A new source is made in two steps of one dialog: its name,
// then what to give the sender, the secret shown that once. Core keeps no
// record of deliveries, so nothing here speaks of them.

/**
 * The mark of a source named after a brand Grasp has one for ("Stripe"),
 * by its name as the admin wrote it; none for any other.
 */
/** Whether a name is a brand's key. */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);

const markOf = (name: string): Brand | undefined => {
  const key = name.trim().toLowerCase();
  return isBrand(key) ? key : undefined;
};

const styles = stylex.create({
  form: { display: "grid", gap: grasp.space3 },
  rowEnd: { display: "flex", alignItems: "center", gap: grasp.space1 },
  // A section's card holding the URL, the secret's state and the recipe.
  setup: {
    display: "grid",
    rowGap: grasp.space3,
    padding: grasp.space3,
  },
  cardWords: {
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
    color: grasp.muted,
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
  },
  // The list and the source opened beside it, as wide as the page lets them be.
  split: {
    display: "grid",
    gridTemplateColumns: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
    columnGap: grasp.space6,
    alignItems: "start",
  },
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
    <CodeBlock
      code={recipeOf(url, secret)}
      copyLabel={t`Copy the example`}
      language="bash"
      languageLabel={t`Send one event`}
      lineNumbers={false}
    />
  );
};

/** A change to a source that asks first. */
type SourceChange = "rotate" | "revoke" | "delete";

/** The confirmation of `change` to source `name`, open while `open`. */
const ConfirmChange = ({
  change,
  name,
  revoked,
  open,
  onOpenChange,
  onConfirm,
}: {
  change: SourceChange;
  name: string;
  revoked: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) => {
  const { t } = useLingui();
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
  const { title, description, confirm } = words[change];
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            onClick={onConfirm}
            variant={change === "delete" ? "danger" : "ink"}
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** What may be done to a source's secret, and the source itself, each asking first. */
const useSourceChanges = (
  source: EventSource,
  onSecret: (secret: string) => void,
  onChanged: () => Promise<void>
) => {
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState<SourceChange>();
  const revoked = source.delivery?.secret === "revoked";
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
  const confirmation =
    asking === undefined ? null : (
      <ConfirmChange
        change={asking}
        name={source.name}
        onConfirm={() => {
          void confirmed(asking);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setAsking(undefined);
          }
        }}
        open
        revoked={revoked}
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
      <DropdownMenuTrigger
        aria-label={t`More for ${name}`}
        disabled={busy}
        icon={More}
        size="sm"
        variant="ghost"
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={Edit}
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
          icon={Trash}
          onSelect={() => {
            onAsk("delete");
          }}
          variant="danger"
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
  const { copied, copy } = useCopy();
  const changes = useSourceChanges(source, onSecret, onChanged);
  const { name } = source;
  const url =
    source.delivery === null ? undefined : urlOf(source.delivery.token);
  const line = useStartsLine(starts);
  const mark = markOf(name);
  return (
    <Item size="xs">
      {mark === undefined ? (
        <ItemMedia icon={Link} iconLook="inline" />
      ) : (
        <ItemMedia>
          <BrandIcon brand={mark} decorative size="md" tile={false} />
        </ItemMedia>
      )}
      <ItemContent>
        <ItemTitle>
          {name}{" "}
          {changes.revoked ? (
            <Badge size="sm" tone="attention">{t`Secret revoked`}</Badge>
          ) : null}
        </ItemTitle>
        {line === undefined ? null : <ItemDescription>{line}</ItemDescription>}
        {changes.failure === undefined ? null : (
          <Alert tone="danger">{changes.failure}</Alert>
        )}
      </ItemContent>
      <ItemActions>
        <div {...stylex.props(styles.rowEnd)}>
          {url === undefined ? null : (
            <Button
              aria-label={copied ? t`Copied` : t`Copy the URL of ${name}`}
              icon={copied ? Tick : Copy}
              onClick={() => {
                void copy(url);
              }}
              size="sm"
              variant="ghost"
            />
          )}
          <Button onClick={onOpen} size="sm" variant="ghost">
            {t`Details`}
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
 * `workflow.start.admitted` events, newest first, `pages` stretches of it
 * at a time; and where an older stretch would start, if any is left.
 */
const startedRuns = async (
  core: Pick<CoreConnection, "withSession">,
  sourceId: string,
  before?: number
): Promise<{ runs: StartedRun[]; next: number | null }> =>
  await core.withSession(async ({ audit }) => {
    const runs: StartedRun[] = [];
    let next: number | null = before ?? null;
    let first = true;
    // A few stretches at most per look: each page reads a bounded part of the log.
    for (let page = 0; page < 5 && runs.length < runsShown; page += 1) {
      if (!first && next === null) {
        break;
      }
      first = false;
      // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
      const read = await audit.search(
        { action: "workflow.start.admitted" },
        next ?? undefined
      );
      runs.push(...read.records.flatMap((record) => runOf(record, sourceId)));
      ({ next } = read);
    }
    return { runs: runs.slice(0, runsShown), next };
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
    const { runs } = await startedRuns(core, sourceId);
    read = { state: "read", runs };
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

/** Quiet words in a section's card, in its rows' inset. */
const CardWords = ({ children }: { children: string }) => (
  <p {...stylex.props(styles.cardWords)}>{children}</p>
);

/**
 * A source, opened beside the list (in a Sheet on a narrow screen, where it
 * isn't `framed`): what the sender needs (its URL, its secret's state and
 * how to sign with it), the workflows it starts, and the runs it started.
 */
const SourceInspector = ({
  source,
  starts,
  framed,
  onClose,
  onSecret,
  onChanged,
}: {
  source: EventSource;
  starts: readonly { id: string; name: string }[] | undefined;
  framed: boolean;
  onClose: () => void;
  onSecret: (secret: string) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const changes = useSourceChanges(source, onSecret, onChanged);
  const runs = useRecentRuns(source.id);
  const { name } = source;
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
  const setup: InspectorSection = {
    id: "setup",
    label: t`Setup`,
    hint: t`What the sender needs: the URL, and the secret it signs with.`,
    action: (
      <Button
        onClick={() => {
          changes.handleAsk("rotate");
        }}
        size="xs"
        variant="ghost"
      >
        {changes.revoked ? t`Make a new secret` : t`Rotate the secret`}
      </Button>
    ),
    content: (
      <div {...stylex.props(styles.setup)}>
        {url === undefined ? null : (
          <CopyField aria-label={t`Copy the URL`} value={url} />
        )}
        {changes.revoked ? (
          <Alert tone="attention">
            {t`The secret is revoked: nothing this source sends starts a workflow until you make it a new one.`}
          </Alert>
        ) : null}
        {url === undefined ? null : <Recipe url={url} />}
        {changes.failure === undefined ? null : (
          <Alert tone="danger">{changes.failure}</Alert>
        )}
      </div>
    ),
  };
  const workflows: InspectorSection =
    starts !== undefined && starts.length > 0
      ? {
          id: "workflows",
          label: t`Workflows it starts`,
          rows: starts.map((workflow) => ({
            id: workflow.id,
            name: workflow.name,
            icon: Workflow,
            onPress: () => {
              openWorkflow(workflow.id, false);
            },
          })),
        }
      : {
          id: "workflows",
          label: t`Workflows it starts`,
          content: (
            <CardWords>
              {starts === undefined
                ? t`The workflows couldn't be read.`
                : t`None yet: a workflow starts on its events from the workflow's Triggers tab.`}
            </CardWords>
          ),
        };
  let recent: InspectorSection;
  if (runs.state === "read" && runs.runs.length > 0) {
    recent = {
      id: "runs",
      label: t`Recent runs`,
      rows: runs.runs.map((run) => ({
        id: `${run.workflowId}-${run.at}`,
        name: names.get(run.workflowId) ?? t`A workflow`,
        icon: Play,
        detail: formatDateTime(run.at),
        onPress: () => {
          openWorkflow(run.workflowId, true);
        },
      })),
    };
  } else {
    const words = {
      reading: t`Reading the runs…`,
      read: t`No run started from it lately.`,
      failed: t`The runs couldn't be read.`,
    }[runs.state];
    recent = {
      id: "runs",
      label: t`Recent runs`,
      content: <CardWords>{words}</CardWords>,
    };
  }
  return (
    <>
      <InspectorPanel
        actions={
          <SourceMenu
            busy={changes.busy}
            name={name}
            onAsk={changes.handleAsk}
            revoked={changes.revoked}
          />
        }
        aria-label={t`Details of ${name}`}
        framed={framed}
        icon={Link}
        onClose={onClose}
        sections={[setup, workflows, recent]}
        title={name}
        words={{ close: t`Close` }}
      />
      {changes.confirmation}
    </>
  );
};

/** A secret core answered once, with the warning that it is shown this once. */
const SecretOnce = ({ secret }: { secret: string }) => {
  const { t } = useLingui();
  return (
    <>
      {/* Mounted with each secret, so Copied never carries over. */}
      <CopyField key={secret} aria-label={t`Copy the secret`} value={secret} />
      <Alert tone="attention">
        {t`Copy it now: you won't see it again. Lost, it can only be replaced.`}
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
      // Once the secret shows, only Done takes it away: never a stray press beside it.
      dismissible={made === undefined}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open={open}
    >
      {made === undefined ? (
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Add a source`}</DialogTitle>
          <DialogBody>
            <form
              aria-label={t`Add a source`}
              id="new-source"
              onSubmit={(submitted) => {
                submitted.preventDefault();
                void add();
              }}
              {...stylex.props(styles.form)}
            >
              <Field invalid={failure !== undefined}>
                <FieldLabel>{t`Name`}</FieldLabel>
                <Input
                  maxLength={80}
                  onValueChange={setName}
                  placeholder="Stripe"
                  required
                  value={name}
                />
                {failure === undefined ? null : (
                  <FieldError match>{failure}</FieldError>
                )}
              </Field>
            </form>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button
              disabled={busy}
              form="new-source"
              type="submit"
              variant="ink"
            >
              {t`Next`}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Give this to the sender`}</DialogTitle>
          <DialogBody>
            <SettingsStack>
              <CopyField aria-label={t`Copy the URL`} value={made.url} />
              <SecretOnce secret={made.secret} />
              <Recipe secret={made.secret} url={made.url} />
            </SettingsStack>
          </DialogBody>
          <DialogFooter>
            <DialogAction variant="ink">{t`Done`}</DialogAction>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
};

/**
 * A secret core answered once on a rotation: shown with the way to copy it
 * and how the sender signs with it, until it is closed on purpose.
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
      // A stray press beside it never takes the secret away: Done or the close button does.
      dismissible={false}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={secret !== undefined}
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`The new secret`}</DialogTitle>
        <DialogBody>
          <SettingsStack>
            {secret === undefined ? null : <SecretOnce secret={secret} />}
          </SettingsStack>
        </DialogBody>
        <DialogFooter>
          <DialogAction variant="ink">{t`Done`}</DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** How wide the page must be for a source to open beside the list. */
const besideFrom = 60 * 16;

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
  // A secret as core just answered it: kept here, above the list, so
  // reading it again never takes the secret away unseen.
  const [secret, setSecret] = useState<string>();
  const [opened, setOpened] = useState<string>();
  const [adding, setAdding] = useState(false);
  // Beside the list where the page has room for both; in a Sheet otherwise.
  const holder = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = holder.current;
    const watch =
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            setWide((entry?.contentRect.width ?? 0) >= besideFrom);
          });
    if (element !== null) {
      watch?.observe(element);
    }
    return () => {
      watch?.disconnect();
    };
  }, []);
  const addButton = (variant: "quiet" | "ink") => (
    <Button
      icon={Plus}
      onClick={() => {
        setAdding(true);
      }}
      size="sm"
      variant={variant}
    >
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
  const inspector = (framed: boolean) =>
    open === undefined ? null : (
      <SourceInspector
        framed={framed}
        key={open.id}
        onChanged={changed}
        onClose={() => {
          setOpened(undefined);
        }}
        onSecret={setSecret}
        source={open}
        starts={startsOf(open.id)}
      />
    );
  const list = (
    <SectionCard
      actions={sources.length > 0 ? addButton("quiet") : null}
      density="compact"
      description={t`Outside systems send events here; workflows start on them.`}
      flush
      title={t`Sources`}
    >
      <SecretDialog
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
      />
      <AddSource onChanged={changed} onOpenChange={setAdding} open={adding} />
      {page.state === "ready" ? null : <SectionNotLoaded page={page} />}
      {page.state === "ready" && sources.length === 0 ? (
        <Empty size="section">
          <EmptyHeader>
            <EmptyDescription>
              {t`Add a source for each system that sends Grasp events.`}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{addButton("ink")}</EmptyContent>
        </Empty>
      ) : null}
      {sources.length > 0 ? (
        <ItemGroup aria-label={t`Sources`} separated>
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
    </SectionCard>
  );
  return (
    <div ref={holder}>
      {wide && open !== undefined ? (
        <div {...stylex.props(styles.split)}>
          {list}
          {inspector(true)}
        </div>
      ) : (
        list
      )}
      <Sheet
        onOpenChange={(next) => {
          if (!next) {
            setOpened(undefined);
          }
        }}
        open={!wide && open !== undefined}
        size="md"
      >
        <SheetContent>
          <SheetTitle>{open?.name ?? ""}</SheetTitle>
          {inspector(false)}
        </SheetContent>
      </Sheet>
    </div>
  );
};
