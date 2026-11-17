import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import { eventSourceHeaders } from "@grasp-os/shared/event-sources";
import type { EventSource } from "@grasp-os/shared/event-sources";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { formatDate, formatList } from "../format.ts";
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
import { Button } from "../grasp/button/index.ts";
import { CopyField } from "../grasp/copy-field/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
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
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Edit, More, Plus, Trash } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Link } from "../grasp/link/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SectionNotLoaded, SettingsStack } from "./section.tsx";

// Settings › Webhooks, for the organization's own admins: the event
// sources outside systems send events to (core's event-sources.ts), one
// per sender ("Stripe", "Shop system"), as rows of one card: its name,
// when it was made, its URL to copy, and a menu to rotate, revoke or
// delete its secret, each asking first. A new source is made in a dialog.
// A secret is shown once, as core answers it on create or rotate, in a
// dialog kept above the list (with how a sender signs with it), so reading
// the list again never takes it away. The card stays mounted whatever its
// list's read came to: a read that fails says so in the list's place.
// Builders start workflows on a source's events from a workflow's Triggers
// tab.

const styles = stylex.create({
  // The URL, under the source's name, as wide as the row lets it.
  url: { marginBlockStart: grasp.space1, maxWidth: "100%" },
  form: { display: "grid", gap: grasp.space3 },
});

/**
 * Where source `token` takes deliveries: on this page's own origin, as
 * core serves both the app and the sources.
 */
const urlOf = (token: string): string =>
  `${globalThis.location.origin}${eventSourcePath}/${token}`;

/** How a sender signs a delivery, by the headers core reads. */
const SigningNote = () => {
  const headers = formatList(Object.values(eventSourceHeaders));
  const example = '{ "type": "payment.paid", "data": { … } }';
  return (
    <Text size="sm" tone="muted">
      <Trans>
        The sender POSTs each event as JSON, with its type and data (
        <code>{example}</code>), signed with the secret as{" "}
        <Link external href="https://www.standardwebhooks.com">
          Standard Webhooks
        </Link>{" "}
        describes, in the headers {headers}. A delivery more than five minutes
        old is refused.
      </Trans>
    </Text>
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

/** One source: its name, its URL, and its menu to rotate, revoke or delete. */
const SourceRow = ({
  source,
  onSecret,
  onChanged,
}: {
  source: EventSource;
  onSecret: (secret: string) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState<SourceChange>();
  const { name } = source;
  const created = formatDate(source.createdAt);
  const url =
    source.delivery === null ? undefined : urlOf(source.delivery.token);
  const revoked = source.delivery?.secret === "revoked";

  const change = async (action: Parameters<typeof run>[0]): Promise<void> => {
    await run(action);
    // Read again whatever came of it.
    await onChanged();
  };
  const confirmed = (which: SourceChange): void => {
    void change(async (session) => {
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
  };

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>
          {name}{" "}
          {revoked ? (
            <Badge size="sm" tone="attention">{t`Secret revoked`}</Badge>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          {revoked
            ? t`Created ${created}. It takes no event until you make it a new secret.`
            : t`Created ${created}`}
        </ItemDescription>
        {url === undefined ? null : (
          <CopyField
            aria-label={t`Copy the URL of ${name}`}
            layout={styles.url}
            value={url}
          />
        )}
        {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
      </ItemContent>
      <ItemActions>
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
                setAsking("rotate");
              }}
            >
              {revoked ? t`Make a new secret` : t`Rotate the secret`}
            </DropdownMenuItem>
            {revoked ? null : (
              <DropdownMenuItem
                onSelect={() => {
                  setAsking("revoke");
                }}
              >
                {t`Revoke the secret`}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={Trash}
              onSelect={() => {
                setAsking("delete");
              }}
              variant="danger"
            >
              {t`Delete`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {asking === undefined ? null : (
          <ConfirmChange
            change={asking}
            name={name}
            onConfirm={() => {
              confirmed(asking);
            }}
            onOpenChange={(open) => {
              if (!open) {
                setAsking(undefined);
              }
            }}
            open
            revoked={revoked}
          />
        )}
      </ItemActions>
    </Item>
  );
};

/** A new source, in a dialog from the card's head: its name. */
const AddSource = ({
  onSecret,
  onChanged,
}: {
  onSecret: (secret: string) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const add = async (): Promise<void> => {
    const created = await run(
      async (session) =>
        await session.workflowResources.sources.create({ name: name.trim() })
    );
    if (created !== undefined) {
      setName("");
      setOpen(false);
      onSecret(created.secret);
    }
    await onChanged();
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger icon={Plus} size="sm">
        {t`Add a source`}
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Add a source`}</DialogTitle>
        <DialogDescription>
          {t`One source per sender: it gets its own URL and secret.`}
        </DialogDescription>
        <DialogBody>
          <form
            aria-label={t`New source`}
            id="new-source"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              void add();
            }}
            {...stylex.props(styles.form)}
          >
            <Field invalid={failure !== undefined}>
              <FieldLabel>{t`Named after its sender`}</FieldLabel>
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
          <Button disabled={busy} form="new-source" type="submit" variant="ink">
            {t`Add the source`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * A secret core answered once: shown with the way to copy it, and how a
 * sender signs with it, until it is closed on purpose.
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
        <DialogTitle>{t`The source's secret`}</DialogTitle>
        <DialogDescription>
          {t`The sender signs every event with it, so Grasp can tell an event is theirs.`}
        </DialogDescription>
        <DialogBody>
          <SettingsStack>
            {/* Mounted with each secret, so Copied never carries over. */}
            <CopyField
              key={secret}
              aria-label={t`Copy the secret`}
              value={secret ?? ""}
            />
            <Alert tone="attention">
              {t`Copy it now: you won't see it again. Lost, it can only be replaced.`}
            </Alert>
            <SigningNote />
          </SettingsStack>
        </DialogBody>
        <DialogFooter>
          <DialogAction variant="ink">{t`Done`}</DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The organization's event sources, for an admin, as their list's read
 * came to (`page`): the list, or why it couldn't be read, in its place.
 */
export const EventSourcesSettings = ({
  page,
}: {
  page: Loaded<readonly EventSource[]>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  // A secret as core just answered it: kept here, above the list, so
  // reading it again never takes the secret away unseen.
  const [secret, setSecret] = useState<string>();
  const changed = async (): Promise<void> => {
    await router.invalidate({ sync: true });
  };
  return (
    <SectionCard
      actions={<AddSource onChanged={changed} onSecret={setSecret} />}
      density="compact"
      description={t`Where outside systems send events, such as a payment that came in. Give each sender its source's URL and secret; workflows start on its events from their Triggers tab.`}
      flush
      title={t`Sources`}
    >
      <SecretDialog
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
      />
      {page.state === "ready" ? null : <SectionNotLoaded page={page} />}
      {page.state === "ready" && page.data.length === 0 ? (
        <Empty size="section">
          <EmptyHeader>
            <EmptyTitle>{t`No source yet`}</EmptyTitle>
            <EmptyDescription>
              {t`Add one for each system that sends Grasp events.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {page.state === "ready" && page.data.length > 0 ? (
        <ItemGroup aria-label={t`Sources`} separated>
          {page.data.map((source) => (
            <SourceRow
              key={source.id}
              onChanged={changed}
              onSecret={setSecret}
              source={source}
            />
          ))}
        </ItemGroup>
      ) : null}
    </SectionCard>
  );
};
