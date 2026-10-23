import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { OnboardingDocument } from "./onboarding-documents.ts";
import { interviewLocaleSchema } from "./onboarding.ts";

// Where the company's documents live (GRA-370): in the onboarding's
// documents step, the admin connects SharePoint and OneDrive, or Google
// Drive, and picks procedures there instead of downloading and dropping
// them. A read-only admin connection of its own, apart from the suite's
// mail and calendars, lists the places, the folders in them and the files
// in those, and fetches a file the admin picked; nothing else in a place
// is read, and nothing is indexed. Core reads each picked file the way it
// reads a dropped one (onboarding-documents.ts).

/** The documents' connections, one per suite: SharePoint and OneDrive, and Google Drive. */
export const placesProviderSchema = z.enum([
  "microsoft-documents",
  "google-documents",
]);
export type PlacesProvider = z.infer<typeof placesProviderSchema>;

/** The suites whose places are read: the ones people sign in with. */
export const placesSuiteSchema = z.enum(["microsoft", "google"]);
export type PlacesSuite = z.infer<typeof placesSuiteSchema>;

/** Each suite's documents connection. */
export const placesProviders: Readonly<Record<PlacesSuite, PlacesProvider>> = {
  microsoft: "microsoft-documents",
  google: "google-documents",
};

/** The suite a documents connection reads. */
export const placesSuiteOf = (provider: PlacesProvider): PlacesSuite =>
  provider === "microsoft-documents" ? "microsoft" : "google";

/** Bounds on what connect answers, so no place can bloat a read. */
export const placesLimits = {
  /** Places one listing answers at most: sites or shared drives, besides the admin's own. */
  placesPerRead: 50,
  /** Items one read of a folder or a search asks the provider for. */
  itemsPerRead: 50,
  /** Longest name of a place or an item kept; longer is cut. */
  nameLength: 120,
  /** Longest ID of a place, a folder or a file. */
  idLength: 256,
  /** Longest search. */
  queryLength: 120,
  /** Longest cursor connect hands back. */
  cursorLength: 2048,
} as const;

/**
 * A place documents live: the admin's own OneDrive or My Drive, a
 * SharePoint site's documents, or a shared drive.
 */
export interface DocumentPlace {
  /** `me` for OneDrive, `my-drive` for My Drive; else the site's or the shared drive's ID. */
  id: string;
  /** As the provider names it: data, never an instruction. */
  name: string;
  kind: "onedrive" | "site" | "my-drive" | "shared-drive";
}

/** A folder or a file in a place. */
export interface PlaceItem {
  id: string;
  /**
   * As the provider names it, cut, and as it is shared: Google's own
   * documents, spreadsheets and presentations end in the extension of
   * the file they are fetched as (`.docx`, `.xlsx`, `.pdf`).
   */
  name: string;
  kind: "folder" | "file";
  /** In bytes; null where the provider says none (Google's own formats). */
  size: number | null;
  /** ISO 8601; null where the provider says none. */
  modifiedAt: string | null;
}

/** The places a documents connection reaches. */
export interface PlacesRead {
  /** The connection's tenant at the provider, as it was connected. */
  tenant: string;
  places: DocumentPlace[];
}

/** One read of a folder, or of a search, in a place. */
export interface PlaceItemsRead {
  tenant: string;
  items: PlaceItem[];
  /** Where the next read starts; null once there is no more. */
  next: string | null;
}

/** A file fetched from a place, for core to read as a dropped one. */
export interface PlaceFile {
  tenant: string;
  /** As in `PlaceItem`: the name it is shared by. */
  name: string;
  bytes: Uint8Array;
}

/** A documents connection, as core finds it. */
export interface PlacesConnection {
  id: string;
  provider: PlacesProvider;
  tenant: string;
  status: "active" | "needs_reauth";
  /** ISO 8601. */
  connectedAt: string;
}

const idSchema = z.string().min(1).max(placesLimits.idLength);

/** What a read of a place's folder or search names, as core and the browser ask it. */
export const placeItemsSchema = z.strictObject({
  place: idSchema,
  /** Null for the place's top. */
  folder: idSchema.nullable(),
  /** A search of the place instead of a folder; null for none. */
  query: z.string().trim().min(1).max(placesLimits.queryLength).nullable(),
  cursor: z.string().min(1).max(placesLimits.cursorLength).nullable(),
});
export type PlaceItemsInput = z.input<typeof placeItemsSchema>;

/** What core asks connect to list. */
export const placesReadRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
});

/** What core asks connect to read of a place. */
export const placeItemsRequestSchema = placeItemsSchema.extend({
  connectionId: z.string().min(1).max(128),
});
export type PlaceItemsRequest = z.input<typeof placeItemsRequestSchema>;

/** What core asks connect to fetch. */
export const placeFileRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  place: idSchema,
  item: idSchema,
});
export type PlaceFileRequest = z.input<typeof placeFileRequestSchema>;

/** A file the admin picked, to share as a document. */
export const sharePlaceFileSchema = z.strictObject({
  locale: interviewLocaleSchema,
  place: idSchema,
  item: idSchema,
});
export type SharePlaceFileInput = z.input<typeof sharePlaceFileSchema>;

/** The documents connection of the onboarding, as its admin sees it. */
export interface OnboardingPlaces {
  suite: PlacesSuite;
  /** Needs reconnecting: its grant ran out, or now grants other access. */
  status: "active" | "needs_reauth";
}

/** Where the documents live, for the client's admin. */
export interface OnboardingPlacesApi {
  /** The documents connection; null before one is connected. */
  documentPlaces: () => Promise<OnboardingPlaces | null>;
  /**
   * Starts connecting the places of `suite`: where to send the browser,
   * which comes back to `returnTo` once the admin consented.
   */
  connectDocumentPlaces: (
    suite: PlacesSuite,
    returnTo: string
  ) => Promise<{ url: string }>;
  /** The places the connection reaches. */
  listDocumentPlaces: () => Promise<DocumentPlace[]>;
  /** A folder of a place, or a search of it, a page at a time. */
  placeItems: (
    input: PlaceItemsInput
  ) => Promise<{ items: PlaceItem[]; next: string | null }>;
  /** Fetches a file the admin picked, on the record, and shares it as a dropped one is. */
  sharePlaceFile: (input: SharePlaceFileInput) => Promise<OnboardingDocument>;
}

/** Why a place couldn't be read. */
export const placeErrors = defineErrorFamily({
  "place.not_found":
    "There's no documents connection with that ID: a connection of another kind is read by nobody here.",
  "place.not_connected": "No place where documents live is connected yet.",
  "place.inactive":
    "This documents connection needs reconnecting by an admin before it can be read.",
  "place.no_item": "That place has no such folder or file.",
  "place.not_a_file": "That isn't a file with content to read.",
  "place.too_large": "That file is larger than 10 MB.",
  "place.cursor_invalid": "That cursor isn't one connect handed back.",
  "place.throttled": "The provider is throttling reads: try again later.",
  "place.provider_failed": "The provider didn't answer the read.",
  "place.other_tenant":
    "These places are another organization's, not the one Grasp signs in with.",
  "place.invalid": "That isn't a valid request for a place.",
});
