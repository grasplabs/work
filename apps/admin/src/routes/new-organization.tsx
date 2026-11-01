import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  createFileRoute,
  Link,
  rootRouteId,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { PageLoading } from "../admin/failure.tsx";
import { domainOfEmail, slugOf } from "../admin/new-organization.ts";
import { AdminPage } from "../admin/page.tsx";
import { HostingChoice } from "../hosting/hosting-choice.tsx";
import type { OrganizationHosting } from "../hosting/organization.ts";
import { clientIdProblem, maxClientIdLength } from "../provision/client-id.ts";
import {
  checkClientIdFn,
  detectSignInFn,
  fetchCreateOptions,
  startClient,
} from "../provision/functions.ts";
import type { DetectedSignIn } from "../provision/sign-in-detect.ts";
import { useProvisionAction } from "../provision/use-action.ts";
import { InvalidFieldError } from "../use-action.ts";

/** How long typing pauses before the address or domain is looked up. */
const lookupPauseMs = 400;

/** How its people sign in: found from its domain, or chosen by hand when that found nothing. */
type SignInChoice =
  | { by: "detected"; found: DetectedSignIn }
  | { by: "hand"; provider: "google" | "microsoft"; value: string };

const providerWords = {
  google: "Google Workspace",
  microsoft: "Microsoft 365",
} as const;

/**
 * What `lookup` answers for `key`, asked once typing pauses while
 * `enabled`, or `failed` when the lookup itself fails; undefined until it
 * has answered for this very key.
 */
const usePausedLookup = <T,>(
  key: string,
  enabled: boolean,
  lookup: (key: string) => Promise<T>,
  failed: T
): T | undefined => {
  const [found, setFound] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    let current = true;
    const ask = async () => {
      let value = failed;
      try {
        value = await lookup(key);
      } catch {
        // Answered all the same, as failed: nothing waits on it for ever.
      }
      if (current) {
        setFound({ key, value });
      }
    };
    const timer = enabled
      ? setTimeout(() => {
          void ask();
        }, lookupPauseMs)
      : undefined;
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, enabled, lookup, failed]);
  return found?.key === key ? found.value : undefined;
};

/** Whether an address is free, as the server says. */
const addressTaken = async (clientId: string): Promise<string | null> => {
  const { problem } = await checkClientIdFn({ data: { clientId } });
  return problem;
};

/** How a domain's people sign in, as found; `failed` when it couldn't be looked up. */
type SignInLookup = DetectedSignIn | { provider: null; failed: true };

const lookupFailed: SignInLookup = { provider: null, failed: true };

/** How a domain's people sign in, as the server finds it: its key is the try and the domain. */
const signInFound = async (key: string): Promise<SignInLookup> =>
  await detectSignInFn({ data: { domain: key.slice(key.indexOf(" ") + 1) } });

/** The web address as typed, checked by its rule and then by the server for being free. */
const useAddressProblem = (clientId: string): string | null => {
  const local = clientId === "" ? null : clientIdProblem(clientId);
  // A check that fails says nothing: creating it still checks.
  const taken = usePausedLookup(
    clientId,
    clientId !== "" && local === null,
    addressTaken,
    null
  );
  return local ?? taken ?? null;
};

/**
 * How `domain`'s people sign in, looked up once typing pauses, again for
 * each `attempt`; null while it isn't known yet.
 */
const useDetectedSignIn = (
  domain: string,
  attempt: number
): SignInLookup | null =>
  usePausedLookup(
    `${attempt} ${domain}`,
    domain.includes("."),
    signInFound,
    lookupFailed
  ) ?? null;

/** The sign-in line under the domains: what was found, or the choice when nothing was. */
const SignInLine = ({
  domain,
  detected,
  choice,
  onChoose,
  onRetry,
}: {
  domain: string;
  detected: SignInLookup | null;
  choice: SignInChoice | null;
  onChoose: (choice: SignInChoice | null) => void;
  onRetry: () => void;
}) => {
  if (domain === "") {
    return null;
  }
  if (choice?.by !== "hand" && detected === null) {
    return (
      <p className="text-muted-foreground text-sm">Finding how they sign in…</p>
    );
  }
  if (
    choice?.by !== "hand" &&
    detected !== null &&
    detected.provider !== null
  ) {
    return (
      <p className="text-sm">
        {`Sign-in: ${providerWords[detected.provider]} `}
        <Button
          onClick={() => {
            onChoose({
              by: "hand",
              provider: detected.provider === "google" ? "microsoft" : "google",
              value: "",
            });
          }}
          size="sm"
          type="button"
          variant="link"
        >
          change
        </Button>
      </p>
    );
  }
  const hand =
    choice?.by === "hand"
      ? choice
      : { by: "hand" as const, provider: "google" as const, value: "" };
  return (
    <Field>
      <FieldLabel htmlFor="org-sign-in">
        {hand.provider === "google"
          ? "Google Workspace primary domain"
          : "Microsoft Entra tenant id"}
      </FieldLabel>
      <Input
        id="org-sign-in"
        onChange={(event) => {
          onChoose({ ...hand, value: event.currentTarget.value });
        }}
        placeholder={
          hand.provider === "google"
            ? domain
            : "00000000-0000-0000-0000-000000000000"
        }
        value={hand.value}
      />
      <FieldDescription>
        {detected !== null && "failed" in detected ? (
          <>
            {`We couldn't look up how ${domain} signs in just now. `}
            <Button onClick={onRetry} size="sm" type="button" variant="link">
              Try again
            </Button>
            {" or "}
          </>
        ) : (
          `We couldn't tell how ${domain} signs in. `
        )}
        <Button
          onClick={() => {
            onChoose({
              ...hand,
              provider: hand.provider === "google" ? "microsoft" : "google",
              value: "",
            });
          }}
          size="sm"
          type="button"
          variant="link"
        >
          {hand.provider === "google"
            ? "Use Microsoft 365 instead"
            : "Use Google Workspace instead"}
        </Button>
      </FieldDescription>
    </Field>
  );
};

/** The sign-in a choice comes to, as the server takes it; why not, when it can't be. */
const signInOf = (
  domains: readonly string[],
  admin: string,
  detected: SignInLookup | null,
  choice: SignInChoice | null
) => {
  const base = { domains: [...domains], admins: [admin.trim().toLowerCase()] };
  if (choice?.by === "hand") {
    if (choice.value.trim() === "") {
      throw new InvalidFieldError(
        choice.provider === "google"
          ? "Give its Google Workspace primary domain."
          : "Give its Microsoft Entra tenant id."
      );
    }
    return choice.provider === "google"
      ? { ...base, googleHostedDomain: choice.value.trim().toLowerCase() }
      : { ...base, entraTenantId: choice.value.trim().toLowerCase() };
  }
  if (detected?.provider === "google") {
    return { ...base, googleHostedDomain: detected.googleHostedDomain };
  }
  if (detected?.provider === "microsoft") {
    return { ...base, entraTenantId: detected.entraTenantId };
  }
  throw new InvalidFieldError("Choose how its people sign in.");
};

/**
 * Adding an organization: its name, its web address (made from the name
 * as it is typed, the platform's domain shown after it), its company's
 * email domains, whose first one tells how its people sign in, its first
 * admin, and where it is hosted. Everything else (its ring, its model
 * spend ceiling, Teams and Rooms) has a default, put right later on its
 * Setup. Creating it starts setting it up at once, and opens its Setup,
 * where its progress shows.
 */
const NewOrganization = () => {
  const { clientDomain } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [domains, setDomains] = useState<string[]>([""]);
  const [admin, setAdmin] = useState<string | null>(null);
  const [hosting, setHosting] = useState<OrganizationHosting>({
    hosting: "grasp_cloud",
    jurisdiction: "eu",
  });
  const [choice, setChoice] = useState<SignInChoice | null>(null);
  const clientId = address ?? slugOf(name);
  const firstDomain = (domains[0] ?? "").trim().toLowerCase();
  const adminEmail = admin ?? (firstDomain === "" ? "" : `@${firstDomain}`);
  const addressProblem = useAddressProblem(clientId);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const detected = useDetectedSignIn(firstDomain, lookupAttempt);
  const { busy, failure, run } = useProvisionAction();
  const create = () => {
    void run(async () => {
      const problem = clientIdProblem(clientId);
      if (problem !== null) {
        throw new InvalidFieldError(problem);
      }
      const typed = domains
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain !== "");
      if (!typed.includes(domainOfEmail(adminEmail))) {
        throw new InvalidFieldError(
          "Its first admin's email must be at one of its email domains."
        );
      }
      const result = await startClient({
        data: {
          clientId,
          name: name.trim(),
          ...hosting,
          signIn: signInOf(typed, adminEmail, detected, choice),
        },
      });
      if (result.clientId !== null) {
        // The organizations stand a minute (src/routes/__root.tsx): read
        // them again, so the one just added is among them.
        await router.invalidate({
          filter: (match) => match.routeId === rootRouteId,
          sync: true,
        });
        await navigate({
          to: "/organizations/$clientId/setup",
          params: { clientId: result.clientId },
        });
      }
      return result;
    });
  };
  return (
    <AdminPage
      description="Grasp sets it up as soon as you create it."
      title="New organization"
    >
      <form
        className="flex max-w-xl flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-name">Name</FieldLabel>
            <Input
              autoComplete="organization"
              id="org-name"
              maxLength={100}
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
              required
              value={name}
            />
          </Field>
          <Field data-invalid={addressProblem !== null}>
            <FieldLabel htmlFor="org-address">Web address</FieldLabel>
            <InputGroup>
              <InputGroupInput
                aria-describedby="org-address-hint"
                aria-invalid={addressProblem !== null}
                autoCapitalize="none"
                id="org-address"
                maxLength={maxClientIdLength}
                onChange={(event) => {
                  setAddress(event.currentTarget.value.toLowerCase());
                }}
                required
                spellCheck={false}
                value={clientId}
              />
              <InputGroupAddon align="inline-end" id="org-address-hint">
                {`.${clientDomain ?? "…"}`}
              </InputGroupAddon>
            </InputGroup>
            {addressProblem === null ? (
              <FieldDescription>
                Where its people open Grasp. It can&apos;t change later.
              </FieldDescription>
            ) : (
              <FieldError>{addressProblem}</FieldError>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="org-domain-0">Company email domain</FieldLabel>
            {domains.map((domain, index) => (
              <Input
                aria-label={index === 0 ? undefined : "Another email domain"}
                autoCapitalize="none"
                id={`org-domain-${index}`}
                // The fields are added and never reordered: their place is their identity.
                key={index}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setDomains(
                    domains.map((each, at) => (at === index ? next : each))
                  );
                  if (index === 0) {
                    setChoice(null);
                  }
                }}
                placeholder={index === 0 ? "acme.com" : "acme.de"}
                required={index === 0}
                spellCheck={false}
                value={domain}
              />
            ))}
            <div>
              <Button
                onClick={() => {
                  setDomains([...domains, ""]);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Add another domain
              </Button>
            </div>
            <SignInLine
              choice={choice}
              detected={detected}
              domain={firstDomain}
              onChoose={setChoice}
              onRetry={() => {
                setLookupAttempt((attempt) => attempt + 1);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="org-admin">
              First admin&apos;s email
            </FieldLabel>
            <Input
              autoCapitalize="none"
              id="org-admin"
              onChange={(event) => {
                setAdmin(event.currentTarget.value);
              }}
              required
              spellCheck={false}
              type="email"
              value={adminEmail}
            />
            <FieldDescription>
              They become its admin when they first sign in.
            </FieldDescription>
          </Field>
          <HostingChoice onChange={setHosting} value={hosting} />
        </FieldGroup>
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button disabled={busy || addressProblem !== null} type="submit">
            Create organization
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
    </AdminPage>
  );
};

/**
 * A new organization, beside the admin's sections rather than under
 * organizations/, where `new` could be a client's id.
 */
export const Route = createFileRoute("/new-organization")({
  loader: async () => await fetchCreateOptions(),
  head: () => ({ meta: [{ title: "New organization" }] }),
  component: NewOrganization,
  pendingComponent: PageLoading,
});
