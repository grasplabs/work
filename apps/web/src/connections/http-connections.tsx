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
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  formatDate,
  formatDateTime,
  formatList,
  formatNumber,
} from "../format.ts";
import { SectionTitle } from "../frame/page.tsx";
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

/** Whether `identity` may approve and revoke HTTP connections: admins, never staff. */
export const managesHttpConnections = (identity: Identity): boolean =>
  isAdmin(identity.role) && !identity.staff;

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
 * The form to approve an HTTP connection: what is typed, the credential
 * above all, and why the last try failed live only as long as it is open.
 */
const AddHttpForm = ({ onAdded }: { onAdded: () => void }) => {
  const { t } = useLingui();
  const ids = useId();
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
      // In the order offered, whatever order they were ticked in.
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

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <Trans>Add an HTTP connection</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            An outside API that domains and workflows can call through Grasp,
            once you allow them to: only this origin, with these methods, under
            these paths.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        id={`${ids}-form`}
        onSubmit={(event) => {
          event.preventDefault();
          approve();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${ids}-name`}>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            autoComplete="off"
            id={`${ids}-name`}
            maxLength={httpLimits.nameChars}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder={t`Billing API`}
            value={name}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-origin`}>
            <Trans>Origin</Trans>
          </FieldLabel>
          <Input
            autoComplete="off"
            id={`${ids}-origin`}
            inputMode="url"
            onChange={(event) => {
              setOrigin(event.target.value);
            }}
            placeholder="https://api.example.com"
            spellCheck={false}
            type="url"
            value={origin}
          />
          <FieldDescription>
            <Trans>
              https:// and a public host name, with nothing after it.
            </Trans>
          </FieldDescription>
        </Field>
        <FieldSet>
          <FieldLegend variant="label">
            <Trans>Methods it allows</Trans>
          </FieldLegend>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {httpMethods.map((method) => (
              <li key={method}>
                <label className="flex items-center gap-2 font-mono">
                  <Checkbox
                    checked={methods.includes(method)}
                    onCheckedChange={(checked) => {
                      const rest = methods.filter((one) => one !== method);
                      setMethods(checked ? [...rest, method] : rest);
                    }}
                  />
                  {method}
                </label>
              </li>
            ))}
          </ul>
        </FieldSet>
        <Field>
          <FieldLabel htmlFor={`${ids}-prefixes`}>
            <Trans>Path prefixes it allows, one per line</Trans>
          </FieldLabel>
          <Textarea
            id={`${ids}-prefixes`}
            onChange={(event) => {
              setPrefixes(event.target.value);
            }}
            placeholder="/v1/invoices"
            spellCheck={false}
            value={prefixes}
            variant="code"
          />
          <FieldDescription>
            <Trans>Each allows everything under it; / allows all paths.</Trans>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-kind`}>
            <Trans>Credential</Trans>
          </FieldLabel>
          <NativeSelect
            id={`${ids}-kind`}
            onChange={(event) => {
              setKind(event.target.value === "bearer" ? "bearer" : "header");
            }}
            value={kind}
          >
            <NativeSelectOption value="header">
              {t`A secret in a header`}
            </NativeSelectOption>
            <NativeSelectOption value="bearer">
              {t`A bearer token`}
            </NativeSelectOption>
          </NativeSelect>
        </Field>
        {kind === "header" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-header`}>
              <Trans>Header name</Trans>
            </FieldLabel>
            <Input
              autoComplete="off"
              id={`${ids}-header`}
              maxLength={64}
              onChange={(event) => {
                setHeader(event.target.value);
              }}
              spellCheck={false}
              value={header}
            />
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${ids}-secret`}>
            {kind === "bearer" ? t`Token` : t`Secret`}
          </FieldLabel>
          <Input
            autoComplete="off"
            id={`${ids}-secret`}
            maxLength={httpLimits.secretChars}
            onChange={(event) => {
              setSecret(event.target.value);
            }}
            spellCheck={false}
            type="password"
            value={secret}
          />
          <FieldDescription>
            <Trans>
              At least {shortest} characters. Grasp keeps it sealed and never
              shows it again, not even to you. To change it, add another
              connection and revoke this one.
            </Trans>
          </FieldDescription>
        </Field>
        <ErrorText>{problem ?? failure}</ErrorText>
      </form>
      <DialogFooter closeLabel={t`Cancel`} showCloseButton>
        <Button disabled={busy} form={`${ids}-form`} type="submit">
          <Trans>Add the connection</Trans>
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
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          latest.current += 1;
          setOpened(latest.current);
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        <PlusIcon data-icon="inline-start" />
        <Trans>Add HTTP connection</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
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
  );
};

/**
 * Revoking, once confirmed: its credential goes, and everything that used
 * it loses it. Named with when it was added too: changing a credential
 * means adding another connection, often by the same name, before
 * revoking the old one.
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
  const { busy, failure, change } = useChange();
  const [confirming, setConfirming] = useState(false);
  const added = formatDateTime(createdAt);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        aria-label={t`Revoke ${name}, added ${added}`}
        disabled={busy}
        onClick={() => {
          setConfirming(true);
        }}
        size="sm"
        variant="outline"
      >
        <Trans context="revoke an HTTP connection">Revoke</Trans>
      </Button>
      {/* Closed as it is confirmed, and off while it runs, so it is asked
          once; what goes wrong shows under the button. */}
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>
                Revoke {name}, added {added}?
              </Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Its credential is deleted, and every domain and workflow loses
                it. Add it again to use it again.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void change(
                  async (session) => await session.connections.disconnect(id)
                );
              }}
              variant="destructive"
            >
              <Trans>Revoke the connection</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

const Detail = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-8">
    <dt className="text-muted-foreground flex-none sm:w-32">{term}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

/** One HTTP connection: where it reaches, what it allows, and, for admins, revoking it. */
const HttpConnectionItem = ({
  listed: { connection, http },
  manages,
}: {
  listed: HttpListed;
  manages: boolean;
}) => {
  const { t } = useLingui();
  const ranOut = connection.status === "needs_reauth";
  const header = http.credentialHeader;
  return (
    <li className="bg-card flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">{http.name}</h3>
        {manages ? (
          <Revoke
            createdAt={connection.createdAt}
            id={connection.id}
            name={http.name}
          />
        ) : null}
      </div>
      <dl className="flex flex-col gap-3">
        <Detail term={t`Origin`}>
          <span className="font-mono">{http.origin}</span>
        </Detail>
        <Detail term={t`Methods`}>
          <span className="font-mono">{formatList(http.methods)}</span>
        </Detail>
        <Detail term={t`Paths`}>
          <span className="font-mono">{formatList(http.pathPrefixes)}</span>
        </Detail>
        <Detail term={t`Credential`}>
          <Trans>
            Sent in <span className="font-mono">{header}</span>, never shown
          </Trans>
        </Detail>
        <Detail term={t`Added on`}>{formatDate(connection.createdAt)}</Detail>
      </dl>
      {ranOut ? (
        <p className="text-muted-foreground">
          <Trans>
            It doesn&apos;t work now. An admin can revoke it and add it again
            with a new credential.
          </Trans>
        </p>
      ) : null}
    </li>
  );
};

/**
 * The HTTP connections this person can see, under their own heading, and
 * for admins the way to add one. Nothing for anyone else while there are
 * none.
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
  const manages = managesHttpConnections(identity);
  const shown =
    connections === undefined
      ? []
      : httpConnectionsMatching(connections, search);
  if (!manages && shown.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="integrations-http"
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle
          count={
            connections === undefined ? undefined : formatNumber(shown.length)
          }
          id="integrations-http"
        >
          <Trans>HTTP connections</Trans>
        </SectionTitle>
        {manages ? <AddHttpConnection /> : null}
      </div>
      <p className="text-muted-foreground">
        {t`Outside APIs an admin approved, by origin, methods and paths. Domains and workflows call them only with a permission.`}
      </p>
      {shown.length === 0 ? null : (
        <ul className="flex flex-col gap-3">
          {shown.map((listed) => (
            <HttpConnectionItem
              key={listed.connection.id}
              listed={listed}
              manages={manages}
            />
          ))}
        </ul>
      )}
    </section>
  );
};
