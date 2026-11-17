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
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPanel,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CopyField } from "../grasp/copy-field/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Input } from "../grasp/input/index.ts";
import { Link } from "../grasp/link/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SectionNotLoaded, SettingsStack } from "./section.tsx";

// Settings › Webhooks, for the organization's own admins: the event
// sources outside systems send events to (core's event-sources.ts), one
// per sender ("Stripe", "Shop system"). Each has a URL, shown with a way
// to copy it, and a secret shown once, as core answers it on create or
// rotate, in a dialog kept above the list so reading it again never takes
// it away. The section stays mounted whatever its list's read came to, so
// a read after a change that fails (offline, refused) says so in place of
// the list and never takes away a secret not yet copied. Rotating,
// revoking and deleting ask first. Builders start workflows on a source's
// events from a workflow's Triggers tab.

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  source: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  actions: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  add: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: grasp.space2,
  },
  name: { flexGrow: 1, minWidth: "12rem" },
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

/** A change to a source that asks first, from a button that says what it does. */
const Confirmed = ({
  button,
  label,
  confirm,
  title,
  description,
  danger = false,
  busy,
  onConfirm,
}: {
  button: string;
  /** The button's full name, naming the source, so one row's is told from another's. */
  label: string;
  confirm: string;
  title: string;
  description: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: () => void;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-label={label}
        disabled={busy}
        size="sm"
        variant={danger ? "danger" : "quiet"}
      >
        {button}
      </AlertDialogTrigger>
      <AlertDialogPanel>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            onClick={onConfirm}
            variant={danger ? "danger" : "ink"}
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogPanel>
    </AlertDialog>
  );
};

/** One source: its URL, its secret's state, and rotating, revoking or deleting it. */
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

  return (
    <li {...stylex.props(styles.source)}>
      <div {...stylex.props(styles.head)}>
        <Text element="span" tone="ink" weight="medium">
          {name}
        </Text>
        {revoked ? <Badge tone="attention">{t`Secret revoked`}</Badge> : null}
        <Text element="span" size="xs" tone="quiet">
          {t`Created ${created}`}
        </Text>
      </div>
      {url === undefined ? null : (
        <CopyField label={t`Copy the URL of ${name}`} value={url} />
      )}
      {revoked ? (
        <Text size="sm" tone="muted">
          {t`It takes no event until you make it a new secret.`}
        </Text>
      ) : null}
      <div {...stylex.props(styles.actions)}>
        <Confirmed
          busy={busy}
          button={revoked ? t`Make a new secret` : t`Rotate the secret`}
          label={
            revoked
              ? t`Make a new secret for ${name}`
              : t`Rotate the secret of ${name}`
          }
          confirm={revoked ? t`Make it` : t`Rotate`}
          description={
            revoked
              ? t`The sender must sign with the new secret, which you see only once.`
              : t`The current secret stops working at once: the sender must sign with the new one, which you see only once.`
          }
          onConfirm={() => {
            void change(async (session) => {
              const { secret } =
                await session.workflowResources.sources.rotateSecret(source.id);
              onSecret(secret);
            });
          }}
          title={revoked ? t`Make a new secret?` : t`Rotate the secret?`}
        />
        {revoked ? null : (
          <Confirmed
            busy={busy}
            button={t`Revoke the secret`}
            label={t`Revoke the secret of ${name}`}
            confirm={t`Revoke`}
            description={t`No event from this source starts anything until you make it a new secret.`}
            onConfirm={() => {
              void change(async (session) => {
                await session.workflowResources.sources.revokeSecret(source.id);
              });
            }}
            title={t`Revoke the secret?`}
          />
        )}
        <Confirmed
          busy={busy}
          button={t`Delete`}
          label={t`Delete ${name}`}
          confirm={t`Delete the source`}
          danger
          description={t`Its URL takes nothing more, and no workflow starts on its events. This can't be undone.`}
          onConfirm={() => {
            void change(async (session) => {
              await session.workflowResources.sources.delete(source.id);
            });
          }}
          title={t`Delete this source?`}
        />
      </div>
      {failure === undefined ? null : <Alert variant="danger">{failure}</Alert>}
    </li>
  );
};

/** A new source: its name. */
const AddSource = ({
  onSecret,
  onChanged,
}: {
  onSecret: (secret: string) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState("");
  const add = async (): Promise<void> => {
    const created = await run(
      async (session) =>
        await session.workflowResources.sources.create({ name: name.trim() })
    );
    if (created !== undefined) {
      setName("");
      onSecret(created.secret);
    }
    await onChanged();
  };
  return (
    <form
      aria-label={t`New source`}
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void add();
      }}
      {...stylex.props(styles.add)}
    >
      <div {...stylex.props(styles.name)}>
        <Field invalid={failure !== undefined}>
          <FieldLabel>{t`New source, named after its sender`}</FieldLabel>
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
      </div>
      <Button disabled={busy} type="submit">
        {t`Add the source`}
      </Button>
    </form>
  );
};

/** A secret core answered once: shown with the way to copy it until it is closed on purpose. */
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
      <DialogPanel closeLabel={t`Close`}>
        <DialogTitle>{t`The source's secret`}</DialogTitle>
        <DialogDescription>
          {t`The sender signs every event with it, so Grasp can tell an event is theirs.`}
        </DialogDescription>
        <DialogBody>
          <SettingsStack>
            {/* Mounted with each secret, so Copied never carries over. */}
            <CopyField
              key={secret}
              label={t`Copy the secret`}
              value={secret ?? ""}
            />
            <Alert variant="attention">
              {t`Copy it now: you won't see it again. Lost, it can only be replaced.`}
            </Alert>
          </SettingsStack>
        </DialogBody>
        <DialogFooter>
          <DialogAction variant="ink">{t`Done`}</DialogAction>
        </DialogFooter>
      </DialogPanel>
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
      description={t`Where outside systems send events, such as a payment that came in. Give each sender its source's URL and secret; workflows start on its events from their Triggers tab, once you allow it.`}
      title={t`Webhooks`}
    >
      <SecretDialog
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
      />
      <SettingsStack>
        <SigningNote />
        {page.state === "ready" ? null : <SectionNotLoaded page={page} />}
        {page.state === "ready" && page.data.length === 0 ? (
          <Text tone="muted">{t`No source yet.`}</Text>
        ) : null}
        {page.state === "ready" && page.data.length > 0 ? (
          <ul aria-label={t`Sources`} {...stylex.props(styles.list)}>
            {page.data.map((source) => (
              <SourceRow
                key={source.id}
                onChanged={changed}
                onSecret={setSecret}
                source={source}
              />
            ))}
          </ul>
        ) : null}
        <AddSource onChanged={changed} onSecret={setSecret} />
      </SettingsStack>
    </SectionCard>
  );
};
