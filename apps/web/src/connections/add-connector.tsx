import { addConnectorSchema } from "@grasp-os/shared/connect";
import type { AddConnector as AddConnectorRequest } from "@grasp-os/shared/connect";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
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
import { Input, SecretInput } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";

import { useCoreAction } from "../use-core-action.ts";
import { integrationKey } from "./integrations.ts";

// Adding a connector by its MCP server's URL (GRA-1375), for an admin: its
// name, the server's address, and how it signs in, at the server (MCP's
// OAuth, with the client its vendor issued where the server registers none
// itself) or with a key each connection gives in a header. Connect checks
// the address, learns the server's sign-in and registers there; the
// connector is then in the catalog, offered, and its page opens.

/** How the server signs in, as the form offers it. */
type AuthKind = AddConnectorRequest["auth"]["kind"];

/** What the form sends, without who and where: core adds those. */
type ConnectorInput = Omit<AddConnectorRequest, "person" | "origin">;

/** The field a refusal names, in words people read. */
const problemTexts = {
  name: msg`Give it a name of at most 80 characters.`,
  url: msg`The address is the server's own https:// URL, such as https://mcp.example.com/mcp.`,
  header: msg`The header is a name of letters, digits and dashes, and not one Grasp sets itself.`,
  client: msg`The client ID is at most 512 characters, and its secret at most 4,096.`,
} as const satisfies Record<string, MessageDescriptor>;

/** Why the form isn't a connector core takes, by the first field wrong. */
const problemOf = ([field, part]: readonly PropertyKey[]): string => {
  if (field === "name" || field === "url") {
    return i18n._(problemTexts[field]);
  }
  return i18n._(part === "client" ? problemTexts.client : problemTexts.header);
};

/** What was typed, as core takes it: a client only where an ID was typed. */
const inputOf = ({
  name,
  url,
  kind,
  header,
  clientId,
  clientSecret,
}: {
  name: string;
  url: string;
  kind: AuthKind;
  header: string;
  clientId: string;
  clientSecret: string;
}): ConnectorInput => {
  if (kind === "header") {
    return {
      name: name.trim(),
      url: url.trim(),
      auth: { kind, header: header.trim() },
    };
  }
  const id = clientId.trim();
  return {
    name: name.trim(),
    url: url.trim(),
    auth:
      id === ""
        ? { kind }
        : {
            kind,
            client: {
              id,
              ...(clientSecret === "" ? {} : { secret: clientSecret }),
            },
          },
  };
};

/**
 * The form: what is typed, the client's secret above all, and why the
 * last try failed live only as long as it is open.
 */
const AddConnectorForm = ({
  onAdded,
}: {
  onAdded: (connectorId: string) => void;
}) => {
  const { t } = useLingui();
  const id = useId();
  const action = useCoreAction();
  const [problem, setProblem] = useState<string>();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<AuthKind>("oauth");
  const [header, setHeader] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const add = (): void => {
    setProblem(undefined);
    const input = inputOf({ name, url, kind, header, clientId, clientSecret });
    // Read here only to say which field is wrong; core and connect read it again.
    const parsed = addConnectorSchema
      .omit({ person: true, origin: true })
      .safeParse(input);
    if (!parsed.success) {
      setProblem(problemOf(parsed.error.issues[0]?.path ?? []));
      return;
    }
    void action.run(async (session) => {
      const added = await session.connections.addConnector(input);
      setClientSecret("");
      onAdded(added.id);
    });
  };

  const said = problem ?? action.failure;
  return (
    <>
      <DialogBody>
        <Form
          id={id}
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Field>
            <FieldLabel>{t`Name`}</FieldLabel>
            <Input
              size="sm"
              autoComplete="off"
              maxLength={80}
              onValueChange={setName}
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel>{t`Server URL`}</FieldLabel>
            <Input
              size="sm"
              autoComplete="off"
              onValueChange={setUrl}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              type="url"
              value={url}
            />
            <FieldDescription>
              {t`The address of its MCP server, as its vendor gives it.`}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>{t`How it signs in`}</FieldLabel>
            <Select
              items={[
                { value: "oauth", label: t`People sign in at the server` },
                { value: "header", label: t`A key in a header` },
              ]}
              onValueChange={(value) => {
                setKind(value === "header" ? "header" : "oauth");
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
                placeholder="x-api-key"
                spellCheck={false}
                value={header}
              />
              <FieldDescription>
                {t`Each person who connects it types their own key, which goes in this header.`}
              </FieldDescription>
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel>{t`Client ID (optional)`}</FieldLabel>
                <Input
                  size="sm"
                  autoComplete="off"
                  onValueChange={setClientId}
                  spellCheck={false}
                  value={clientId}
                />
                <FieldDescription>
                  {t`Only for a server that doesn't register Grasp itself: the client its vendor issued for Grasp.`}
                </FieldDescription>
              </Field>
              {clientId.trim() === "" ? null : (
                <Field>
                  <FieldLabel>{t`Client secret (optional)`}</FieldLabel>
                  <SecretInput
                    size="sm"
                    onValueChange={setClientSecret}
                    spellCheck={false}
                    value={clientSecret}
                  />
                  <FieldDescription>
                    {t`Grasp keeps it sealed and never shows it again.`}
                  </FieldDescription>
                </Field>
              )}
            </>
          )}
          {said === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>{said}</AlertTitle>
            </Alert>
          )}
        </Form>
      </DialogBody>
      <DialogFooter>
        <DialogClose>{t`Cancel`}</DialogClose>
        <Button disabled={action.busy} form={id} type="submit">
          {t`Add the connector`}
        </Button>
      </DialogFooter>
    </>
  );
};

/**
 * Adding a connector by URL, in a dialog opened from the page's head:
 * for the company's own admins, never Grasp staff.
 */
export const AddConnector = ({ identity }: { identity: Identity }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // One more each time it opens: the form mounts anew, with nothing of
  // the last time in it, not even while the dialog is still closing.
  const [opened, setOpened] = useState(0);
  // The opening now showing: an add that ends after its dialog was closed
  // and opened again neither closes it nor leaves the page.
  const latest = useRef(0);
  const navigate = useNavigate();
  if (!isMemberAdmin(identity)) {
    return null;
  }
  return (
    <>
      <Button
        onClick={() => {
          latest.current += 1;
          setOpened(latest.current);
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <Icon icon={PlusIcon} />
        {t`Add connector`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Add a connector by URL`}</DialogTitle>
            <DialogDescription>
              {t`Any app with its own MCP server. Grasp keeps the access in your deployment, and people connect it from its page.`}
            </DialogDescription>
          </DialogHeader>
          <AddConnectorForm
            key={opened}
            onAdded={(connectorId) => {
              if (latest.current !== opened) {
                return;
              }
              setOpen(false);
              void navigate({
                to: "/connectors/$integration",
                params: {
                  integration: integrationKey("connector", connectorId),
                },
              });
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
};
