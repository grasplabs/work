import { newClientIdSchema } from "@grasp-os/shared/router";
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
import {
  createFileRoute,
  Link,
  rootRouteId,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  domainsOrAdmins,
  prefillOf,
  startingPointsOf,
} from "../admin/new-organization.ts";
import type { StartingPoint } from "../admin/new-organization.ts";
import { AdminPage } from "../admin/page.tsx";
import { ringChoices, ringWords } from "../admin/platform-parts.tsx";
import { SettingUpNow } from "../admin/setup-actions.tsx";
import type { Refresh } from "../admin/setup-actions.tsx";
import { formatDate } from "../admin/words.ts";
import { signInOf, textOf } from "../clients/sign-in-fields.tsx";
import type { WonDeal } from "../crm/attio.ts";
import { fetchWonDeals } from "../crm/functions.ts";
import { clientIdProblem } from "../provision/client-id.ts";
import {
  fetchNewClientOptions,
  fetchProvisioning,
  startClient,
} from "../provision/functions.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { useProvisionAction } from "../provision/use-action.ts";
import { releaseName } from "../releases/version.ts";
import { InvalidFieldError } from "../use-action.ts";

/** Client `clientId`'s provisioning; null for none, or an id that can't be one. */
const provisioningOf = async (
  clientId: string
): Promise<ProvisioningView | null> => {
  if (!newClientIdSchema.safeParse(clientId).success) {
    return null;
  }
  return await fetchProvisioning({ data: { clientId } });
};

/** Where the organization starts from: by hand, or a deal won in Attio; Rooms is still to come. */
const StartFrom = ({
  starts,
  value,
  onChange,
}: {
  starts: readonly StartingPoint[];
  value: StartingPoint["id"];
  onChange: (value: StartingPoint["id"]) => void;
}) => (
  <FieldSet>
    <FieldLegend variant="label">Start from</FieldLegend>
    <FieldDescription>
      What a deal or a proposal knows is filled in below, to put right before it
      is added.
    </FieldDescription>
    <RadioGroup
      name="startFrom"
      onValueChange={(next) => {
        const start = starts.find((each) => each.id === next);
        if (start !== undefined) {
          onChange(start.id);
        }
      }}
      value={value}
    >
      {starts.map((start) => (
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

/** A won deal in a line: what it is called, its company and the day it was won. */
const dealLabel = (deal: WonDeal): string =>
  [
    deal.title === "" ? deal.name : `${deal.title}, ${deal.name}`,
    deal.on === null ? "" : `won ${formatDate(deal.on)}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");

/** Which won deal it starts from: its company fills in the fields below. */
const DealChoice = ({
  deals,
  dealId,
  onChange,
}: {
  deals: readonly WonDeal[];
  dealId: string;
  onChange: (dealId: string) => void;
}) => (
  <Field>
    <FieldLabel htmlFor="org-deal">The deal</FieldLabel>
    <NativeSelect
      className="w-full"
      id="org-deal"
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
      value={dealId}
    >
      {deals.map((deal) => (
        <NativeSelectOption key={deal.dealId} value={deal.dealId}>
          {dealLabel(deal)}
        </NativeSelectOption>
      ))}
    </NativeSelect>
    <FieldDescription>
      Its company is linked to the organization, so Details reads it from Attio.
    </FieldDescription>
  </Field>
);

/** Reads the page again: its own route alone, as it follows the run. */
const useRefreshPage = (): Refresh => {
  const router = useRouter();
  return async () => {
    await router.invalidate({
      filter: (match) => match.routeId === "/new-organization",
      sync: true,
    });
  };
};

/** How often the page reads the run again while it works on its own. */
const followMs = 5000;

/**
 * Added: setting it up followed here until the admin records it, as
 * the prototype's dialog ends on the way in. Until then it has no page
 * among the organizations (they are the clients the admin recorded);
 * once it has, its Setup follows the rest. A run that stopped before it
 * recorded the company says why, to add it again.
 */
const Following = ({
  clientId,
  view,
}: {
  clientId: string;
  view: ProvisioningView | null;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const refresh = useRefreshPage();
  const working =
    view !== null && view.client === null && view.phase !== "failed";
  useEffect(() => {
    const timer = working
      ? setInterval(() => {
          void refresh();
        }, followMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [working, refresh]);
  if (view === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {`There's no organization ${clientId} being set up.`}
      </p>
    );
  }
  const openSetup = async () => {
    // The organizations stand a minute (src/routes/admin.tsx): read them
    // again, so the one recorded since is among them.
    await router.invalidate({
      filter: (match) => match.routeId === rootRouteId,
      sync: true,
    });
    await navigate({
      to: "/organizations/$clientId/setup",
      params: { clientId },
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        {view.client === null
          ? `${clientId} is being set up: its own Cloudflare account, its Grasp, and its address. It shows among the organizations once the admin has recorded it.`
          : `${view.client.name} is recorded: its Setup follows the rest of setting it up.`}
      </p>
      <section
        aria-label="Setting it up"
        className="bg-card overflow-hidden rounded-xl border text-sm"
      >
        <SettingUpNow refresh={refresh} view={view} />
      </section>
      <div className="flex items-center gap-2">
        {view.client === null ? null : (
          <Button
            onClick={() => {
              void openSetup();
            }}
          >
            Open its Setup
          </Button>
        )}
        <Button
          nativeButton={false}
          render={
            <Link
              // The organizations stand a minute (src/routes/admin.tsx): read
              // them again, so one recorded since shows.
              onClick={() => {
                void router.invalidate({
                  filter: (match) => match.routeId === rootRouteId,
                });
              }}
              to="/"
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
 * starts its provisioning, the same the admin's new-client form starts,
 * audited as that is (`client.provision_start`).
 *
 * Left out, as the admin keeps nowhere to put them yet: its website,
 * what it is, its language, who decided on Grasp, and marking it a test.
 */
const NewOrganization = () => {
  const { releases, won, following } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const starts = startingPointsOf(won);
  const deals = won.state === "read" ? won.deals : [];
  // A deal won and not added yet is what an organization most likely
  // starts from: the latest is chosen, to change or put right.
  const [startFrom, setStartFrom] = useState<StartingPoint["id"]>(
    deals.length > 0 ? "attio" : "hand"
  );
  const [dealId, setDealId] = useState(deals[0]?.dealId ?? "");
  const deal =
    startFrom === "attio"
      ? deals.find((each) => each.dealId === dealId)
      : undefined;
  const prefill =
    deal === undefined
      ? { name: "", clientId: "", domains: "" }
      : prefillOf(deal);
  const { busy, failure, run } = useProvisionAction();
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
          ...(deal === undefined ? {} : { attioCompanyId: deal.companyId }),
        },
      });
      if (result.clientId !== null) {
        await navigate({
          to: "/new-organization",
          search: { following: result.clientId },
        });
      }
      return result;
    });
  };
  const [newest] = releases;
  if (search.following !== undefined) {
    return (
      <AdminPage
        title={`${following?.client?.name ?? search.following} is added`}
      >
        <Following clientId={search.following} view={following} />
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
            <StartFrom
              onChange={setStartFrom}
              starts={starts}
              value={startFrom}
            />
            {startFrom === "attio" ? (
              <DealChoice dealId={dealId} deals={deals} onChange={setDealId} />
            ) : null}
            <Field>
              <FieldLabel htmlFor="org-name">Name</FieldLabel>
              <Input
                defaultValue={prefill.name}
                id="org-name"
                // Keyed by the deal: the field starts again from the one chosen.
                key={`name-${deal?.dealId ?? ""}`}
                maxLength={100}
                name="name"
                required
              />
              <FieldDescription>
                The company, as Grasp&apos;s staff know it.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="org-id">Its address</FieldLabel>
              <Input
                defaultValue={prefill.clientId}
                id="org-id"
                key={`id-${deal?.dealId ?? ""}`}
                maxLength={50}
                name="clientId"
                required
              />
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
                <Input
                  defaultValue={prefill.domains}
                  id="org-domains"
                  key={`domains-${deal?.dealId ?? ""}`}
                  name="domains"
                />
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
                      {releaseName(release)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>The release it starts on.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="org-ring">Ring</FieldLabel>
                <NativeSelect
                  className="w-full"
                  defaultValue="1"
                  id="org-ring"
                  name="ring"
                >
                  {ringChoices(0).map((ring) => (
                    <NativeSelectOption key={ring} value={String(ring)}>
                      {ringWords(ring)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  When rollouts reach it: Alpha (our own deployments) first,
                  then Beta, then Production.
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
              render={<Link to="/" />}
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
export const Route = createFileRoute("/new-organization")({
  // The organization just added, followed until the admin records it.
  validateSearch: (search: Record<string, unknown>): { following?: string } =>
    typeof search.following === "string" ? { following: search.following } : {},
  loaderDeps: ({ search }) => ({ following: search.following }),
  loader: async ({ deps }) => {
    const [options, won, following] = await Promise.all([
      fetchNewClientOptions(),
      fetchWonDeals(),
      deps.following === undefined ? null : provisioningOf(deps.following),
    ]);
    return { ...options, won, following };
  },
  head: () => ({ meta: [{ title: "New organization" }] }),
  component: NewOrganization,
});
