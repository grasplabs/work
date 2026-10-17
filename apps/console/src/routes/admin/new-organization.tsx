import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import {
  domainsOrAdmins,
  startingPoints,
} from "../../admin/new-organization.ts";
import { AdminPage } from "../../admin/page.tsx";
import { signInOf, textOf } from "../../clients/sign-in-fields.tsx";
import { clientIdProblem } from "../../provision/client-id.ts";
import {
  fetchNewClientOptions,
  startClient,
} from "../../provision/functions.ts";
import { useProvisionAction } from "../../provision/use-action.ts";
import { InvalidFieldError } from "../../use-action.ts";

/** Where the organization starts from: by hand, until the console reads Attio and Rooms. */
const StartFrom = () => (
  <FieldSet>
    <FieldLegend variant="label">Start from</FieldLegend>
    <FieldDescription>
      What a deal or a proposal knows is filled in below, to put right before it
      is added.
    </FieldDescription>
    <RadioGroup defaultValue="hand" name="startFrom">
      {startingPoints.map((start) => (
        <FieldLabel htmlFor={`start-${start.id}`} key={start.id}>
          <Field
            data-disabled={start.unavailable !== null}
            orientation="horizontal"
          >
            <RadioGroupItem
              disabled={start.unavailable !== null}
              id={`start-${start.id}`}
              value={start.id}
            />
            <FieldContent>
              <FieldTitle>{start.label}</FieldTitle>
              <FieldDescription>
                {start.unavailable ?? start.description}
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  </FieldSet>
);

/** Started: where its provisioning is followed, as the prototype's dialog ends on the way in. */
const Started = ({ clientId, name }: { clientId: string; name: string }) => {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        {`${name} is being set up: its own Cloudflare account, its Grasp, and its address. It shows among the organizations once the console has recorded it.`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          nativeButton={false}
          render={<Link params={{ clientId }} to="/clients/$clientId" />}
        >
          Follow its provisioning
        </Button>
        <Button
          nativeButton={false}
          render={
            <Link
              // The organizations stand a minute (src/routes/admin.tsx): read
              // them again, so one recorded since shows.
              onClick={() => {
                void router.invalidate({
                  filter: (match) => match.routeId === "/admin",
                });
              }}
              to="/admin"
            />
          }
          variant="outline"
        >
          Back to the organizations
        </Button>
      </div>
    </div>
  );
};

/**
 * Adding an organization, ported from the prototype's dialog as a page of
 * the admin's own: who it is, who goes through the onboarding (its first
 * admin, who the prototype sent a link and who here signs in with the
 * company's own Microsoft or Google), and where its Grasp runs. Adding it
 * starts its provisioning, the same the console's new-client form starts,
 * audited as that is (`client.provision_start`).
 *
 * Left out, as the console keeps nowhere to put them yet: its website,
 * what it is, its language, who decided on Grasp, and marking it a test.
 */
const NewOrganization = () => {
  const { releases } = Route.useLoaderData();
  const { busy, failure, run } = useProvisionAction();
  const [started, setStarted] = useState<{
    clientId: string;
    name: string;
  } | null>(null);
  const add = (form: FormData) => {
    const accountId = textOf(form, "accountId");
    const clientId = textOf(form, "clientId");
    const name = textOf(form, "name");
    form.set(
      "domains",
      domainsOrAdmins(textOf(form, "domains"), textOf(form, "admins"))
    );
    void run(async () => {
      // The server's own rule, said before anything is sent.
      const problem = clientIdProblem(clientId);
      if (problem !== null) {
        throw new InvalidFieldError(problem);
      }
      const result = await startClient({
        data: {
          clientId,
          name,
          releaseId: textOf(form, "releaseId"),
          ring: Number(textOf(form, "ring")),
          signIn: signInOf(form),
          ...(accountId === "" ? {} : { accountId }),
        },
      });
      if (result.clientId !== null) {
        setStarted({ clientId: result.clientId, name });
      }
      return result;
    });
  };
  const [newest] = releases;
  if (started !== null) {
    return (
      <AdminPage title={`${started.name} is added`}>
        <Started clientId={started.clientId} name={started.name} />
      </AdminPage>
    );
  }
  return (
    <AdminPage
      description="Its first admin signs in with the company's own Microsoft or Google, and goes through the onboarding from there."
      title="New organization"
    >
      {newest === undefined ? (
        <p className="text-muted-foreground text-sm">
          No release is imported yet, so there is nothing to set it up on.
        </p>
      ) : (
        <form
          className="flex max-w-xl flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            add(new FormData(event.currentTarget));
          }}
        >
          <FieldGroup>
            <StartFrom />
            <Field>
              <FieldLabel htmlFor="org-name">Name</FieldLabel>
              <Input id="org-name" maxLength={100} name="name" required />
              <FieldDescription>
                The company, as Grasp&apos;s staff know it.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="org-id">Its address</FieldLabel>
              <Input id="org-id" maxLength={50} name="clientId" required />
              <FieldDescription>
                Its hostname: lowercase letters, digits and dashes. It
                can&apos;t change.
              </FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">
                Who goes through the onboarding
              </FieldLegend>
              <Field>
                <FieldLabel htmlFor="org-admins">Email</FieldLabel>
                <Input id="org-admins" name="admins" required />
                <FieldDescription>
                  They get the admin role when they first sign in. More than
                  one, separated by commas.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="org-domains">Email domains</FieldLabel>
                <Input id="org-domains" name="domains" />
                <FieldDescription>
                  The domains its people sign in with, separated by commas. Left
                  empty, the admins&apos; own.
                </FieldDescription>
              </Field>
            </FieldSet>
            <FieldSet>
              <FieldLegend variant="label">How its people sign in</FieldLegend>
              <Field>
                <FieldLabel htmlFor="org-entra">Entra tenant id</FieldLabel>
                <Input id="org-entra" name="entraTenantId" />
                <FieldDescription>
                  If its people sign in with Microsoft.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="org-google">
                  Google Workspace domain
                </FieldLabel>
                <Input id="org-google" name="googleHostedDomain" />
                <FieldDescription>
                  Its primary domain, if its people sign in with Google.
                </FieldDescription>
              </Field>
            </FieldSet>
            <FieldSet>
              <FieldLegend variant="label">Where its Grasp runs</FieldLegend>
              <Field>
                <FieldLabel htmlFor="org-release">Release</FieldLabel>
                <NativeSelect
                  className="w-full"
                  defaultValue={newest.id}
                  id="org-release"
                  name="releaseId"
                >
                  {releases.map((release) => (
                    <NativeSelectOption key={release.id} value={release.id}>
                      {release.id}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>The release it starts on.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="org-ring">Ring</FieldLabel>
                <Input
                  defaultValue={1}
                  id="org-ring"
                  min={0}
                  name="ring"
                  required
                  type="number"
                />
                <FieldDescription>
                  When rollouts reach it: ring 0 first.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="org-account">
                  Cloudflare account id
                </FieldLabel>
                <Input
                  id="org-account"
                  name="accountId"
                  pattern="[0-9a-f]{32}"
                />
                <FieldDescription>
                  An account to adopt, with the deployer a member. Left empty,
                  one is created (partner accounts only).
                </FieldDescription>
              </Field>
            </FieldSet>
          </FieldGroup>
          {failure === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button disabled={busy} type="submit">
              Add organization
            </Button>
            <Button
              nativeButton={false}
              render={<Link to="/admin" />}
              variant="outline"
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </AdminPage>
  );
};

/**
 * A new organization, beside the admin's sections rather than under
 * organizations/, where `new` could be a client's id.
 */
export const Route = createFileRoute("/admin/new-organization")({
  loader: async () => await fetchNewClientOptions(),
  head: () => ({ meta: [{ title: "New organization" }] }),
  component: NewOrganization,
});
