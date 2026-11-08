import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import { eventSourceHeaders } from "@grasp-os/shared/event-sources";
import type { EventSource } from "@grasp-os/shared/event-sources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Confirmed } from "../confirmed.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDate, formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { CopyButton, ShownOnceDialog } from "../shown-once.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SettingsBody, SettingsSection } from "./settings-parts.tsx";

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
    <p className="text-muted-foreground text-sm">
      <Trans>
        The sender POSTs each event as JSON, with its type and data (
        <code className="font-mono">{example}</code>), signed with the secret as{" "}
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
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{name}</span>
        {revoked ? (
          <Badge variant="attention">
            <Trans>Secret revoked</Trans>
          </Badge>
        ) : null}
        <span className="text-muted-foreground text-xs">
          <Trans>Created {created}</Trans>
        </span>
      </div>
      {url === undefined ? null : (
        <div className="flex min-w-0 items-center gap-2">
          <Input aria-label={t`URL of ${name}`} readOnly value={url} />
          <CopyButton label={t`Copy the URL of ${name}`} text={url} />
        </div>
      )}
      {revoked ? (
        <p className="text-muted-foreground text-sm">
          <Trans>It takes no event until you make it a new secret.</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Confirmed
          busy={busy}
          button={revoked ? t`Make a new secret` : t`Rotate the secret`}
          confirm={revoked ? t`Make a new secret` : t`Rotate the secret`}
          description={
            revoked
              ? t`The sender must sign with the new secret, which you see only once.`
              : t`The current secret stops working at once: the sender must sign with the new one, which you see only once.`
          }
          label={
            revoked
              ? t`Make a new secret for ${name}`
              : t`Rotate the secret of ${name}`
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
            confirm={t`Revoke the secret`}
            description={t`No event from this source starts anything until you make it a new secret.`}
            label={t`Revoke the secret of ${name}`}
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
          confirm={t`Delete the source`}
          description={t`Its URL takes nothing more, and no workflow starts on its events. This can't be undone.`}
          label={t`Delete ${name}`}
          onConfirm={() => {
            void change(async (session) => {
              await session.workflowResources.sources.delete(source.id);
            });
          }}
          title={t`Delete this source?`}
        />
      </div>
      <ErrorText>{failure}</ErrorText>
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
  const ids = useId();
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
      className="flex flex-col gap-2 border-t px-5 py-4"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void add();
      }}
    >
      <Label htmlFor={`${ids}-name`}>
        <Trans>New source, named after its sender</Trans>
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${ids}-name`}
          maxLength={80}
          onChange={(changed) => {
            setName(changed.target.value);
          }}
          placeholder="Stripe"
          required
          value={name}
        />
        <Button disabled={busy} size="sm" type="submit">
          <Trans>Add the source</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </form>
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
    <SettingsSection
      description={
        <Trans>
          Where outside systems send events, such as a payment that came in.
          Give each sender its source&apos;s URL and secret; workflows start on
          its events from their Triggers tab, once you allow it.
        </Trans>
      }
      title={t`Webhooks`}
    >
      <ShownOnceDialog
        description={
          <Trans>
            The sender signs every event with it, so Grasp can tell an event is
            theirs.
          </Trans>
        }
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
        title={<Trans>The source&apos;s secret</Trans>}
      />
      <SettingsBody>
        <SigningNote />
      </SettingsBody>
      {page.state !== "ready" && (
        <div className="border-t">
          <NotLoadedState heading="h3" page={page} />
        </div>
      )}
      {page.state === "ready" && page.data.length === 0 && (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>No source yet.</Trans>
        </p>
      )}
      {page.state === "ready" && page.data.length > 0 && (
        <ul className="flex flex-col divide-y border-t">
          {page.data.map((source) => (
            <SourceRow
              key={source.id}
              onChanged={changed}
              onSecret={setSecret}
              source={source}
            />
          ))}
        </ul>
      )}
      <AddSource onChanged={changed} onSecret={setSecret} />
    </SettingsSection>
  );
};
