import { actorOf } from "@grasp-os/shared/audit";
import {
  placeErrors,
  placeItemsSchema,
  placesProviders,
  placesSuiteOf,
  placesSuiteSchema,
  sharePlaceFileSchema,
} from "@grasp-os/shared/document-places";
import type {
  DocumentPlace,
  OnboardingPlaces,
  PlaceItem,
  PlacesConnection,
} from "@grasp-os/shared/document-places";
import {
  documentErrors,
  shareDocumentSchema,
} from "@grasp-os/shared/onboarding-documents";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { appendAuditEvent } from "../audit-outbox.ts";
import { signInConfig } from "../auth/config.ts";
import { tenantOf } from "../connections.ts";
import { startOnboardingConnection } from "./connections.ts";
import { shareDocument } from "./documents.ts";

// Where the company's documents live (GRA-370): in the onboarding's
// documents step the admin connects SharePoint and OneDrive, or Google
// Drive, and picks procedures there instead of downloading and dropping
// them. Core lists the places and their folders through connect for the
// admin's browser, and fetches only a file the admin picked, on the
// record, to read it exactly as a dropped one is read (documents.ts).
// Nothing else in a place is read, and nothing of it is kept but the
// documents shared.

/**
 * The documents connection the onboarding reads: one of the
 * organization's own tenant, a working one before one that needs
 * reconnecting, the newest first. Another tenant's is never read.
 */
const connectionOf = async (
  env: Env
): Promise<PlacesConnection | undefined> => {
  const config = signInConfig(env);
  if (config === undefined) {
    return undefined;
  }
  const listed = await env.CONNECT.placesConnections();
  return listed
    .filter(
      ({ provider, tenant }) =>
        tenant.toLowerCase() ===
        tenantOf(config, placesSuiteOf(provider))?.toLowerCase()
    )
    .toSorted(
      (one, other) =>
        Number(one.status !== "active") - Number(other.status !== "active") ||
        other.connectedAt.localeCompare(one.connectedAt)
    )[0];
};

/**
 * The connection the client's admin reads with: a working one of their
 * organization. The client's files are the client's: not Grasp staff's
 * to read.
 */
const readableConnection = async (
  env: Env,
  identity: Identity
): Promise<PlacesConnection> => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const connection = await connectionOf(env);
  if (connection === undefined) {
    throw placeErrors.create("place.not_connected");
  }
  if (connection.status !== "active") {
    throw placeErrors.create("place.inactive");
  }
  return connection;
};

/** Refuses a read that answers for another tenant than the connection's. */
const requireTenant = (
  connection: PlacesConnection,
  { tenant }: { tenant: string }
): void => {
  if (tenant.toLowerCase() !== connection.tenant.toLowerCase()) {
    throw placeErrors.create("place.other_tenant");
  }
};

/** The documents connection of the onboarding; null before one is. */
export const onboardingPlaces = async (
  env: Env,
  identity: Identity
): Promise<OnboardingPlaces | null> => {
  requireAdmin(identity);
  const connection = await connectionOf(env);
  return connection === undefined
    ? null
    : {
        suite: placesSuiteOf(connection.provider),
        status: connection.status,
      };
};

/** Starts connecting the places of `suite`, from the step at `returnTo`. */
export const connectPlaces = async (
  env: Env,
  identity: Identity,
  suite: unknown,
  returnTo: unknown
): Promise<{ url: string }> => {
  const parsed = placesSuiteSchema.safeParse(suite);
  if (!parsed.success) {
    throw placeErrors.create("place.invalid");
  }
  return await startOnboardingConnection(env, identity, {
    provider: placesProviders[parsed.data],
    suite: parsed.data,
    returnTo,
  });
};

/** The places the onboarding's documents connection reaches. */
export const listPlaces = async (
  env: Env,
  identity: Identity
): Promise<DocumentPlace[]> => {
  const connection = await readableConnection(env, identity);
  const read = await env.CONNECT.readPlaces({ connectionId: connection.id });
  requireTenant(connection, read);
  return read.places;
};

/** A folder of a place, or a search of it, a page at a time: names, never content. */
export const placeItems = async (
  env: Env,
  identity: Identity,
  input: unknown
): Promise<{ items: PlaceItem[]; next: string | null }> => {
  const asked = placeErrors.parse("place.invalid", placeItemsSchema, input);
  const connection = await readableConnection(env, identity);
  const read = await env.CONNECT.readPlaceItems({
    connectionId: connection.id,
    ...asked,
  });
  requireTenant(connection, read);
  return { items: read.items, next: read.next };
};

/**
 * Shares a file the admin picked in a place: on the record before it is
 * fetched, fetched through connect, then read exactly as a dropped file is
 * (documents.ts), from its name and its bytes. A file too large, or of a
 * kind that can't be read, is refused as a dropped one would be.
 */
export const sharePlaceFile = async (
  env: Env,
  identity: Identity,
  input: unknown
): Promise<OnboardingDocument> => {
  const { locale, place, item } = placeErrors.parse(
    "place.invalid",
    sharePlaceFileSchema,
    input
  );
  const connection = await readableConnection(env, identity);
  await appendAuditEvent(env, {
    actor: actorOf(identity),
    action: "onboarding.document_fetched",
    target: { type: "connection", id: connection.id },
    detail: { place, item },
  });
  let file: Awaited<ReturnType<typeof env.CONNECT.readPlaceFile>>;
  try {
    file = await env.CONNECT.readPlaceFile({
      connectionId: connection.id,
      place,
      item,
    });
  } catch (error) {
    if (placeErrors.codeOf(error) === "place.too_large") {
      throw documentErrors.create("document.too_large");
    }
    throw error;
  }
  requireTenant(connection, file);
  // Connect's name is a file name already; checked as a dropped one's is.
  const shared = documentErrors.parse("document.invalid", shareDocumentSchema, {
    locale,
    name: file.name,
    bytes: file.bytes,
  });
  return await shareDocument(env, identity, shared);
};
