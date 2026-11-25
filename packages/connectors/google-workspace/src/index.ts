import { defineConnector } from "@grasp-os/connector-kit/connector";
import { auth } from "@grasp-os/sdk/connector";

import { calendarSync } from "./calendar-sync.ts";
import { calendarTools } from "./calendar.ts";
import { draftTools } from "./drafts.ts";
import { driveSync } from "./drive-sync.ts";
import { driveTools } from "./drive.ts";
import { gmailSync } from "./gmail-sync.ts";
import { gmailTools } from "./gmail.ts";
import { apisHost, gmailHost, sheetsHost } from "./google.ts";
import { sharedDriveSync } from "./shared-drive-sync.ts";
import { sheetsTools } from "./sheets.ts";

/** A Google OAuth scope, by its name under Google's prefix. */
const scope = (name: string): string =>
  `https://www.googleapis.com/auth/${name}`;

/**
 * Google's sign-in: OpenID Connect with Grasp's Workspace app, pinned to
 * the organization's own hosted domain. Google can only hint at the domain
 * (`hd`), so the ID token's `hd` is what counts, with a verified address.
 * `access_type=offline` with `prompt=consent` is how Google gives a refresh
 * token every time. Revoking one token revokes the account's whole grant
 * with this client. Core names people by address in the reader lists it
 * copies (reader-groups), so the address counts only while each renewal
 * confirms it again: from the renewal's ID token, which Google returns
 * from a refresh, or else Google's userinfo endpoint.
 *
 * Asked by class (connect's provider-rights.ts):
 * - Always: the sign-in, and the groups the account is in, which core
 *   counts the person in a copied reader list's group by.
 * - Read own: reading their mailbox.
 * - Change own: labelling and drafting mail (`gmail.modify`), putting an
 *   event in their own calendar (`calendar.events`, and the calendar list
 *   that says which is theirs) and drafts in their own Drive (`drive.file`:
 *   only the files Grasp made).
 * - Read company: colleagues' and groups' calendars and the shared drives'
 *   files and spreadsheets. Nothing changes the company's or reads others'
 *   words.
 * - Reach others: `gmail.send`. Gmail can't split sending off modifying:
 *   `gmail.modify` sends too, so once Change own is on the grant can send
 *   whether Reach others is on or not. There Reach others is held by its
 *   class alone: core refuses sending before it signs a call for connect
 *   while the class is off for the person.
 */
const googleAuth = auth.oauth2({
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  grant: "account",
  tenant: "domain",
  params: { access_type: "offline", prompt: "consent", hd: "{tenant}" },
  idToken: {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    subject: "sub",
    name: ["email"],
    email: ["email"],
    claims: { hd: "{tenant}", email_verified: true },
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  },
  scopes: {
    openid: "Sign in",
    email: "Your address",
    profile: "Your name",
    [scope("cloud-identity.groups.readonly")]: "The groups you are in",
    [scope("gmail.readonly")]: "Read your mail",
    [scope("gmail.modify")]: "Label, draft and send your mail",
    [scope("gmail.send")]: "Send mail as you",
    [scope("calendar.events")]: "Put events in your calendar",
    [scope("calendar.events.readonly")]: "Read calendars",
    [scope("calendar.calendarlist.readonly")]: "Know which calendar is yours",
    [scope("drive.readonly")]: "Read files and spreadsheets",
    [scope("drive.file")]: "Make drafts in your Drive",
  },
  rights: {
    signIn: [
      "openid",
      "email",
      "profile",
      scope("cloud-identity.groups.readonly"),
    ],
    classes: {
      "read-own": [scope("gmail.readonly")],
      "change-own": [
        scope("gmail.modify"),
        scope("calendar.events"),
        scope("calendar.calendarlist.readonly"),
        scope("drive.file"),
      ],
      "read-company": [
        scope("calendar.events.readonly"),
        scope("drive.readonly"),
      ],
      "change-company": [],
      "reach-others": [scope("gmail.send")],
      "read-others": [],
    },
    // Modifying mail reads and sends it, and writing events reads them.
    // `drive.file` reads only Grasp's own files: it takes in no reading.
    implied: {
      [scope("gmail.modify")]: [scope("gmail.readonly"), scope("gmail.send")],
      [scope("calendar.events")]: [scope("calendar.events.readonly")],
    },
  },
});

/**
 * Native Google Workspace connector, on Google's APIs: Gmail of one
 * mailbox, one calendar, and the files and spreadsheets of one shared
 * drive, per call, and drafts in the person's own Drive.
 *
 * Scopes, the least the tools need: `gmail.modify` (read, label, draft
 * and send; applying labels to a message needs it, and it can't delete
 * for good), `calendar.events` (events only, not calendar settings or
 * sharing; it writes, and calendar.ts holds writes to the person's own
 * calendar), `calendar.calendarlist.readonly` (which calendar is their
 * own), `drive.readonly` (reading a file's content needs it, and Sheets
 * takes it to read a spreadsheet's cells) and `drive.file` (drafts: only
 * the files this app made).
 *
 * It syncs the person's own Drive (drive-sync.ts), on `drive.readonly`,
 * mailbox (gmail-sync.ts), on `gmail.modify`, and primary calendar
 * (calendar-sync.ts), on `calendar.events`, for the Brain; and, on a
 * shared connection, the shared drives an admin picked
 * (shared-drive-sync.ts), on `drive.readonly`.
 */
export default defineConnector({
  name: "google-workspace",
  provider: "google",
  signIn: { ...googleAuth.signIn, name: "Google Workspace" },
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ],
  hosts: [gmailHost, apisHost, sheetsHost, "openidconnect.googleapis.com"],
  tools: [
    ...gmailTools,
    ...calendarTools,
    ...driveTools,
    ...sheetsTools,
    ...draftTools,
  ],
  syncs: [driveSync, gmailSync, calendarSync, sharedDriveSync],
});
