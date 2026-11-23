import type { ListedConnection } from "@grasp-os/shared/connect";
import {
  httpConnectionSchema,
  httpLimits,
  httpMethods,
} from "@grasp-os/shared/http-connections";
import type {
  HttpConnectionInput,
  HttpMethod,
} from "@grasp-os/shared/http-connections";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
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
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
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
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { Heading } from "@grasp-os/ui/components/heading";
import { Input, SecretInput } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Globe2Icon, Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useId, useRef, useState } from "react";

import {
  formatDate,
  formatDateTime,
  formatList,
  formatNumber,
} from "../format.ts";
import { InfoTip } from "./info-tip.tsx";
import { httpConnectionsOf } from "./integrations.ts";
import type { HttpListed } from "./integrations.ts";
import { useChange } from "./use-change.ts";

// HTTP connections (GRA-1478): outside APIs an admin approved, each one
// https origin, the methods and path prefixes it allows, and a credential
// connect keeps sealed. Listed apart from the catalog's apps, as connect
// lists them (`connections.list`, with `http`): never the credential, only
// the header it goes in. An admin who isn't Grasp staff approves one
// (`connections.createHttp`) and revokes one (`connections.disconnect`,
// after asking). Core and connect decide both again. A connection is
// never edited, by design: another origin, scope or credential is another
// connection, so a grant always covers exactly what an admin approved.

/**
 * The live HTTP connections among `connections` whose name or origin holds
 * `search`: what the Integrations page shows and counts.
 */
export const httpConnectionsMatching = (
  connections: readonly ListedConnection[],
  search: string | undefined
): HttpListed[] => {
  const needle = (search ?? "").trim().toLocaleLowerCase();
  return httpConnectionsOf(connections).filter(
    ({ http }) =>
      http.name.toLocaleLowerCase().includes(needle) ||
      http.origin.toLocaleLowerCase().includes(needle)
  );
};

/** The credential's kinds, as the form offers them. */
type CredentialKind = "header" | "bearer";

/** The longest name, as the form says it. */
const longest = httpLimits.nameChars;

/** The shortest credential connect takes, as the form says it. */
const shortest = httpLimits.secretMinChars;

/** The field a refusal names, in words people read. */
const problemTexts = {
  name: msg`Give it a name of at most ${longest} characters.`,
  origin: msg`The origin is https:// and a public host name, with nothing after it: https://api.example.com.`,
  pathPrefixes: msg`Each path prefix starts with /, on its own line, with no query or dot segments.`,
  methods: msg`Allow at least one method.`,
  credential: msg`The credential needs a header name (letters, digits and dashes) and a secret of at least ${shortest} plain ASCII characters, on one line.`,
} as const satisfies Record<string, MessageDescriptor>;

/** Why the form isn't a connection core takes, by the first field wrong. */
const problemOf = (field: PropertyKey | undefined): string => {
  if (
    field === "name" ||
    field === "origin" ||
    field === "pathPrefixes" ||
    field === "methods"
  ) {
    return i18n._(problemTexts[field]);
  }
  return i18n._(problemTexts.credential);
};

/** The prefixes typed, one per line, blank lines left out. */
const prefixesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * The form to approve an HTTP connection, on Damsko's fields: what is
 * typed, the credential above all, and why the last try failed live only
 * as long as it is open. Its methods are chosen by seeing, each a toggle.
 */
const AddHttpForm = ({ onAdded }: { onAdded: () => void }) => {
  const { t } = useLingui();
  const id = useId();
  const { busy, failure, change } = useChange();
  const [problem, setProblem] = useState<string>();
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [methods, setMethods] = useState<HttpMethod[]>(["GET"]);
  const [prefixes, setPrefixes] = useState("/");
  const [kind, setKind] = useState<CredentialKind>("header");
  const [header, setHeader] = useState("x-api-key");
  const [secret, setSecret] = useState("");

  const approve = (): void => {
    setProblem(undefined);
    const input: HttpConnectionInput = {
      name: name.trim(),
      origin: origin.trim(),
      // In the order offered, whatever order they were chosen in.
      methods: httpMethods.filter((method) => methods.includes(method)),
      pathPrefixes: prefixesOf(prefixes),
      credential:
        kind === "bearer"
          ? { kind: "bearer", token: secret }
          : { kind: "header", header: header.trim(), secret },
    };
    // Read here only to say which field is wrong; core reads it again.
    const parsed = httpConnectionSchema.safeParse(input);
    if (!parsed.success) {
      setProblem(problemOf(parsed.error.issues[0]?.path[0]));
      return;
    }
    void change(async (session) => {
      await session.connections.createHttp(input);
      setSecret("");
      onAdded();
    });
  };

  const said = problem ?? failure;
  return (
    <>
      <DialogBody>
        <Form
          id={id}
          onSubmit={(event) => {
            event.preventDefault();
            approve();
          }}
        >
          <Field>
            <FieldLabel>{t`Name`}</FieldLabel>
            <Input
              size="sm"
              autoComplete="off"
              maxLength={httpLimits.nameChars}
              onValueChange={setName}
              placeholder={t`Billing API`}
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel>{t`Origin`}</FieldLabel>
            <Input
              size="sm"
              autoComplete="off"
              onValueChange={setOrigin}
              placeholder="https://api.example.com"
              spellCheck={false}
              type="url"
              value={origin}
            />
            <FieldDescription>
              {t`https:// and a public host name, with nothing after it.`}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>{t`Methods it allows`}</FieldLabel>
            <ToggleGroup
              aria-label={t`Methods it allows`}
              multiple
              onValueChange={(next: readonly string[]) => {
                setMethods(
                  httpMethods.filter((method) => next.includes(method))
                );
              }}
              value={methods}
            >
              {httpMethods.map((method) => (
                <ToggleGroupItem key={method} value={method}>
                  {method}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel>{t`Path prefixes it allows, one per line`}</FieldLabel>
            <Textarea
              onValueChange={setPrefixes}
              placeholder="/v1/invoices"
              rows={3}
              spellCheck={false}
              value={prefixes}
            />
            <FieldDescription>
              {t`Each allows everything under it; / allows all paths.`}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>{t`Credential`}</FieldLabel>
            <Select
              items={[
                { value: "header", label: t`A secret in a header` },
                { value: "bearer", label: t`A bearer token` },
              ]}
              onValueChange={(value) => {
                setKind(value === "bearer" ? "bearer" : "header");
              }}
              value={kind}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          </Field>
          {kind === "header" ? (
            <Field>
              <FieldLabel>{t`Header name`}</FieldLabel>
              <Input
                size="sm"
                autoComplete="off"
                maxLength={64}
                onValueChange={setHeader}
                spellCheck={false}
                value={header}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel>{kind === "bearer" ? t`Token` : t`Secret`}</FieldLabel>
            <SecretInput
              size="sm"
              maxLength={httpLimits.secretChars}
              onValueChange={setSecret}
              value={secret}
            />
            <FieldDescription>
              {t`At least ${shortest} characters. Grasp keeps it sealed and never shows it again, not even to you. To change it, add another connection and revoke this one.`}
            </FieldDescription>
          </Field>
          {said === undefined ? null : (
            <Alert variant="destructive">
              <AlertDescription>{said}</AlertDescription>
            </Alert>
          )}
        </Form>
      </DialogBody>
      <DialogFooter>
        <DialogClose>{t`Cancel`}</DialogClose>
        <Button disabled={busy} form={id} size="sm" type="submit">
          {t`Add the connection`}
        </Button>
      </DialogFooter>
    </>
  );
};

/** Approving an HTTP connection, in a dialog: its credential is typed here once and never shown again. */
const AddHttpConnection = () => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // One more each time it opens: the form mounts anew, with nothing of
  // the last time in it, not even while the dialog is still closing.
  const [opened, setOpened] = useState(0);
  // The opening now showing, read when an add ends: an add that ends after
  // its dialog was closed and opened again closes nothing, so it never
  // takes away the form someone is typing in now.
  const latest = useRef(0);
  return (
    <>
      {/* "Add" beside the card's title, which says what; its full name for a screen reader. */}
      <Button
        aria-label={t`Add HTTP connection`}
        onClick={() => {
          latest.current += 1;
          setOpened(latest.current);
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <Icon icon={PlusIcon} />
        {t`Add`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Add an HTTP connection`}</DialogTitle>
          </DialogHeader>
          {/* Mounted anew each time it opens: nothing of the last time
              is left in it, not the credential, nor why an add failed. */}
          <AddHttpForm
            key={opened}
            onAdded={() => {
              if (latest.current === opened) {
                setOpen(false);
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
};

/**
 * Revoking, once confirmed: its credential goes, and everything that used
 * it loses it. Named with when it was added too: changing a credential
 * means adding another connection, often by the same name, before
 * revoking the old one. A failure says so on the dialog's button, and why
 * under it.
 */
const Revoke = ({
  name,
  id,
  createdAt,
}: {
  name: string;
  id: string;
  createdAt: string;
}) => {
  const { t } = useLingui();
  const { failure, change } = useChange();
  const [open, setOpen] = useState(false);
  const added = formatDateTime(createdAt);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger asChild>
        <Button
          aria-label={t`Revoke ${name}, added ${added}`}
          size="sm"
          variant="ghost"
        >
          {t({ message: "Revoke", context: "revoke an HTTP connection" })}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Revoke ${name}, added ${added}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Its credential is deleted, and every App and workflow loses it. Add it again to use it again.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failure === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            errorLabel={t`Couldn't revoke`}
            onClick={async () => {
              let revoked = false;
              await change(async (session) => {
                await session.connections.disconnect(id);
                revoked = true;
              });
              if (!revoked) {
                throw new Error("Not revoked");
              }
              setOpen(false);
            }}
            size="sm"
            variant="destructive"
          >
            {t`Revoke the connection`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** One HTTP connection, as a row: where it reaches, what it allows, and for admins Revoke. */
const HttpRow = ({
  listed: { connection, http },
  manages,
}: {
  listed: HttpListed;
  manages: boolean;
}) => {
  const { t } = useLingui();
  const methods = formatList(http.methods);
  const paths = formatList(http.pathPrefixes);
  const header = http.credentialHeader;
  const added = formatDate(connection.createdAt);
  const { origin } = http;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon icon={Globe2Icon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{http.name}</ItemTitle>
        <ItemDescription>
          {t`${origin} · ${methods} under ${paths} · sent in ${header} · added ${added}`}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {connection.status === "needs_reauth" ? (
          <Badge variant="warning">{t`Doesn't work now`}</Badge>
        ) : null}
        {manages ? (
          <Revoke
            createdAt={connection.createdAt}
            id={connection.id}
            name={http.name}
          />
        ) : null}
      </ItemActions>
    </Item>
  );
};

const styles = stylex.create({
  item: { minWidth: 0, listStyle: "none" },
  // A title and its info mark, on one line.
  titled: { display: "inline-flex", alignItems: "center", gap: space["1"] },
  // The card's title row alone: the title at its start, Add at its end.
  bare: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  mono: { fontFamily: font.mono },
});

/** One HTTP connection: where it reaches, what it allows, and, for admins, revoking it. */
export const HttpConnectionItem = ({
  listed: { connection, http },
  manages,
  heading = "h3",
}: {
  listed: HttpListed;
  manages: boolean;
  /** Its name's heading, under the list's own. */
  heading?: "h3" | "h4";
}) => {
  const { t } = useLingui();
  const ranOut = connection.status === "needs_reauth";
  const header = http.credentialHeader;
  return (
    <li {...stylex.props(styles.item)}>
      <Card size="sm">
        <CardHeader>
          <CardTitle level={heading === "h4" ? 4 : 3}>{http.name}</CardTitle>
          {manages ? (
            <CardAction>
              <Revoke
                createdAt={connection.createdAt}
                id={connection.id}
                name={http.name}
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          <KeyValueList
            items={[
              {
                id: "origin",
                label: t`Origin`,
                value: http.origin,
                mono: true,
              },
              {
                id: "methods",
                label: t`Methods`,
                value: formatList(http.methods),
                mono: true,
              },
              {
                id: "paths",
                label: t`Paths`,
                value: formatList(http.pathPrefixes),
                mono: true,
              },
              {
                id: "credential",
                label: t`Credential`,
                value: (
                  <Trans>
                    Sent in <span {...stylex.props(styles.mono)}>{header}</span>
                    , never shown
                  </Trans>
                ),
              },
              {
                id: "added",
                label: t`Added on`,
                value: formatDate(connection.createdAt),
              },
            ]}
            orientation="horizontal"
          />
          {ranOut ? (
            <Text color="muted" size="sm">
              <Trans>
                It doesn&apos;t work now. An admin can revoke it and add it
                again with a new credential.
              </Trans>
            </Text>
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
};

/**
 * The HTTP connections this person can see, as a compact card of rows,
 * and for admins the way to add one at its head. Nothing for anyone else
 * while there are none.
 */
export const HttpConnections = ({
  connections,
  identity,
  search,
}: {
  /** Undefined until they are read, or when they couldn't be. */
  connections: readonly ListedConnection[] | undefined;
  identity: Identity;
  /** What the page's search narrows the list to, by name or origin. */
  search: string | undefined;
}) => {
  const { t } = useLingui();
  // Admins approve and revoke HTTP connections, never Grasp staff.
  const manages = isMemberAdmin(identity);
  const shown =
    connections === undefined
      ? []
      : httpConnectionsMatching(connections, search);
  if (!manages && shown.length === 0) {
    return null;
  }
  const title = t`HTTP connections`;
  const about = (
    <InfoTip label={t`More about HTTP connections`}>
      {t`Outside APIs an admin approved, by origin, methods and paths. Apps and workflows call them only with a permission.`}
    </InfoTip>
  );
  return (
    <Card asChild padding={shown.length === 0 ? "default" : "none"} size="sm">
      <section aria-label={title}>
        {shown.length === 0 ? (
          // Nothing listed yet: the card is its title row alone, at the size
          // of a dense card's title.
          <div {...stylex.props(styles.bare)}>
            <span {...stylex.props(styles.titled)}>
              <Heading level={2} size="2xs">
                {title}
              </Heading>
              {about}
            </span>
            {manages ? <AddHttpConnection /> : null}
          </div>
        ) : (
          <>
            <CardHeader>
              <CardTitle level={2}>
                <span {...stylex.props(styles.titled)}>
                  {title}
                  {about}
                </span>
              </CardTitle>
              <CardAction>
                <Text as="span" color="muted" size="sm">
                  {formatNumber(shown.length)}
                </Text>
                {manages ? <AddHttpConnection /> : null}
              </CardAction>
            </CardHeader>
            <CardContent flush>
              <ItemGroup aria-label={title}>
                {shown.map((listed, index) => (
                  <Fragment key={listed.connection.id}>
                    {index > 0 ? <ItemSeparator /> : null}
                    <HttpRow listed={listed} manages={manages} />
                  </Fragment>
                ))}
              </ItemGroup>
            </CardContent>
          </>
        )}
      </section>
    </Card>
  );
};
