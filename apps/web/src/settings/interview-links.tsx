import { failureText } from "@grasp-os/shared/errors";
import type { LinkToSend } from "@grasp-os/shared/onboarding";
import type {
  Campaign,
  CampaignAsk,
} from "@grasp-os/shared/onboarding-campaign";
import { Button } from "@grasp-os/ui/components/button";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import { Field, FieldError, FieldLabel } from "@grasp-os/ui/components/field";
import { Form, FormFooter } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { DownloadIcon, Icon } from "@grasp-os/ui/lib/icons";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { downloadCsv } from "../csv.ts";
import { fullLink, linksCsv } from "../onboarding/links-to-send.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { interviewStyles as styles } from "./interviews.styles.ts";
import { NamedRows, RowNote, SettingsGroup, TitleLine } from "./section.tsx";

// Settings › Interviews › Links: what of the links still needs the admin.
// Whose link mail failed for good (the campaign's `mail` asks), to put
// their address right, which sends it again (`onboarding.correctAddress`,
// only for a failed mail), or to hand them their link. And, where the
// deployment sends no mail (`OnboardingView.mailSends`), every link that
// is out and not sent yet (`LinkToSend.fresh`), to copy, send and mark as
// sent (`onboarding.linksTaken`). A link is someone's own: it opens only
// once they sign in with the company's sign-in.

type MailAsk = Extract<CampaignAsk, { kind: "mail" }>;

/** The address to correct, under the row it belongs to: core's refusal is said at the field. */
const AddressForm = ({
  ask,
  onClose,
  onChanged,
}: {
  ask: MailAsk;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [address, setAddress] = useState(ask.email);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const { name } = ask;
  const send = async (): Promise<void> => {
    setBusy(true);
    setRefused(undefined);
    try {
      await core.withSession(async (session) => {
        await session.onboarding.correctAddress(ask.person, address.trim());
      });
    } catch (error) {
      setRefused(failureText(error));
      setBusy(false);
      return;
    }
    // Sent: the mail is no longer one that failed, so the row leaves the list.
    await onChanged();
  };
  return (
    <Form
      aria-label={t`Correct the address of ${name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      style={styles.form}
    >
      <Field data-invalid={refused !== undefined}>
        <FieldLabel>{t`Email address`}</FieldLabel>
        <Input
          autoComplete="off"
          onValueChange={(value) => {
            setAddress(value);
            setRefused(undefined);
          }}
          required
          size="sm"
          type="email"
          value={address}
        />
        <FieldError match="valueMissing">{t`Enter their email address.`}</FieldError>
        <FieldError match="typeMismatch">{t`Enter a whole email address.`}</FieldError>
        {refused === undefined ? null : (
          <FieldError match>{refused}</FieldError>
        )}
      </Field>
      <FormFooter align="start">
        <Button onClick={onClose} size="sm" type="button" variant="outline">
          {t`Cancel`}
        </Button>
        <Button disabled={busy} size="sm" type="submit">
          {t`Send again`}
        </Button>
      </FormFooter>
    </Form>
  );
};

/** Someone whose link mail failed: their address to correct, or their link to hand over. */
const FailedMailRow = ({
  ask,
  link,
  onChanged,
}: {
  ask: MailAsk;
  link: LinkToSend | undefined;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [correcting, setCorrecting] = useState(false);
  const { name, email } = ask;
  const path = link?.path ?? null;
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>
          <TitleLine detail={ask.team}>{name}</TitleLine>
        </ItemTitle>
        <ItemDescription>
          {email === ""
            ? t`They have no email address on the staff list.`
            : t`Our email to ${email} didn’t arrive.`}
        </ItemDescription>
        {correcting ? (
          <AddressForm
            ask={ask}
            onChanged={onChanged}
            onClose={() => {
              setCorrecting(false);
            }}
          />
        ) : null}
      </ItemContent>
      {correcting ? null : (
        <ItemActions>
          <span {...stylex.props(styles.ends)}>
            {path === null ? null : (
              <CopyButton
                aria-label={t`Copy the link for ${name}`}
                value={() => fullLink(path, window.location.origin)}
              />
            )}
            <Button
              aria-label={t`Correct the address of ${name}`}
              onClick={() => {
                setCorrecting(true);
              }}
              size="sm"
              variant="outline"
            >
              {t`Correct the address`}
            </Button>
          </span>
        </ItemActions>
      )}
    </Item>
  );
};

/** One link to send by hand: to copy, and to mark as sent once it went. */
const LinkRow = ({
  link,
  path,
  onChanged,
}: {
  link: LinkToSend;
  path: string;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const { name, email } = link;
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>
          <TitleLine detail={link.team}>{name}</TitleLine>
        </ItemTitle>
        <ItemDescription>
          <RowNote failure={failure}>
            {email === "" ? t`No email address: hand it over yourself.` : email}
          </RowNote>
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span {...stylex.props(styles.ends)}>
          <CopyButton
            aria-label={t`Copy the link for ${name}`}
            value={() => fullLink(path, window.location.origin)}
          />
          <Button
            aria-label={t`Mark the link for ${name} as sent`}
            disabled={busy}
            onClick={() => {
              void (async () => {
                await run(async (session) => {
                  await session.onboarding.linksTaken([link.person]);
                });
                await onChanged();
              })();
            }}
            size="sm"
            variant="outline"
          >
            {t`Mark as sent`}
          </Button>
        </span>
      </ItemActions>
    </Item>
  );
};

/** The links out and not sent yet, where the admin sends them all. */
const ToSend = ({
  fresh,
  onChanged,
}: {
  fresh: LinkToSend[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  if (fresh.length === 0) {
    return null;
  }
  return (
    <NamedRows label={t`To send`}>
      <ItemGroup aria-label={t`Links to send`} separated>
        {fresh.map((link) =>
          link.path === null ? null : (
            <LinkRow
              key={link.person}
              link={link}
              onChanged={onChanged}
              path={link.path}
            />
          )
        )}
      </ItemGroup>
      <Item size="xs">
        <ItemContent>
          <ItemDescription>
            <RowNote failure={failure}>
              {t`As a list, to mail-merge: name, email, team and link.`}
            </RowNote>
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <span {...stylex.props(styles.ends)}>
            <Button
              onClick={() => {
                downloadCsv(
                  linksCsv(fresh, window.location.origin, [
                    t`Name`,
                    t`Email`,
                    t`Team`,
                    t`Link`,
                  ]),
                  "grasp-links.csv"
                );
              }}
              size="sm"
              variant="ghost"
            >
              <Icon icon={DownloadIcon} />
              {t`Download`}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                void (async () => {
                  await run(async (session) => {
                    await session.onboarding.linksTaken(
                      fresh.map(({ person }) => person)
                    );
                  });
                  await onChanged();
                })();
              }}
              size="sm"
              variant="ghost"
            >
              {t`Mark all as sent`}
            </Button>
          </span>
        </ItemActions>
      </Item>
    </NamedRows>
  );
};

/** Where the links stand, in one line at the card's foot. */
const useLinksLine = (links: readonly LinkToSend[]): string => {
  const { t } = useLingui();
  const all = links.length;
  const out = links.filter((link) => link.path !== null).length;
  const waiting = all - out;
  if (waiting === 0) {
    return plural(all, {
      one: "The one link is out.",
      other: "All # links are out.",
    });
  }
  return t`${out} of ${all} links are out. The others go out on their day, or once their team’s lead has talked.`;
};

/** What of the links needs the admin: the mails that failed, and the links to send by hand. */
export const InterviewLinks = ({
  campaign,
  links,
  mailSends,
  onChanged,
}: {
  campaign: Campaign;
  links: LinkToSend[];
  /** Whether the deployment sends mail: where it doesn't, every link goes out by hand. */
  mailSends: boolean;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const failed = campaign.asks.filter((ask) => ask.kind === "mail");
  // A failed mail's link stands with the mail, not twice.
  const failedPeople = new Set(failed.map(({ person }) => person));
  const fresh = mailSends
    ? []
    : links.filter(
        (link) =>
          link.path !== null && link.fresh && !failedPeople.has(link.person)
      );
  const line = useLinksLine(links);
  const nothing = failed.length === 0 && fresh.length === 0;
  let empty = t`Nothing to do: no email failed.`;
  if (!mailSends) {
    empty = t`Nothing to send: every link that is out has been sent.`;
  }
  return (
    <SettingsGroup
      description={
        mailSends
          ? t`Grasp emails everyone their own link. Here is what still needs you.`
          : t`Grasp sends no email here, so every link goes out by you: copy it, send it, then mark it as sent.`
      }
      flush={!nothing}
      footer={
        links.length === 0 ? undefined : (
          <Text color="muted" size="xs">
            {line}
          </Text>
        )
      }
      title={t`Links`}
    >
      {nothing ? <Text color="muted">{empty}</Text> : null}
      {failed.length === 0 ? null : (
        <NamedRows label={t`Email that didn’t arrive`}>
          <ItemGroup aria-label={t`Email that didn’t arrive`} separated>
            {failed.map((ask) => (
              <FailedMailRow
                ask={ask}
                key={ask.person}
                link={links.find(({ person }) => person === ask.person)}
                onChanged={onChanged}
              />
            ))}
          </ItemGroup>
        </NamedRows>
      )}
      <ToSend fresh={fresh} onChanged={onChanged} />
    </SettingsGroup>
  );
};
