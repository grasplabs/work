import { withNativeSyncs } from "@grasp-os/runtime/connector";
import { auth, defineConnector } from "@grasp-os/sdk/connector";

import { calendarSync } from "./calendar-sync.ts";
import { calendarTools } from "./calendar.ts";
import { draftTools } from "./drafts.ts";
import { driveSync } from "./drive-sync.ts";
import { driveTools } from "./drive.ts";
import { gmailSync } from "./gmail-sync.ts";
import { gmailTools } from "./gmail.ts";
import {
  apisHost,
  gmailHost,
  googleErrors,
  googleScope,
  sheetsHost,
} from "./google.ts";
import { sharedDriveSync } from "./shared-drive-sync.ts";
import { sheetsTools } from "./sheets.ts";

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
    [googleScope("cloud-identity.groups.readonly")]: "The groups you are in",
    [googleScope("gmail.readonly")]: "Read your mail",
    [googleScope("gmail.modify")]: "Label, draft and send your mail",
    [googleScope("gmail.send")]: "Send mail as you",
    [googleScope("calendar.events")]: "Put events in your calendar",
    [googleScope("calendar.events.readonly")]: "Read calendars",
    [googleScope("calendar.calendarlist.readonly")]:
      "Know which calendar is yours",
    [googleScope("drive.readonly")]: "Read files and spreadsheets",
    [googleScope("drive.file")]: "Make drafts in your Drive",
  },
  rights: {
    signIn: [
      "openid",
      "email",
      "profile",
      googleScope("cloud-identity.groups.readonly"),
    ],
    classes: {
      "read-own": [googleScope("gmail.readonly")],
      "change-own": [
        googleScope("gmail.modify"),
        googleScope("calendar.events"),
        googleScope("calendar.calendarlist.readonly"),
        googleScope("drive.file"),
      ],
      "read-company": [
        googleScope("calendar.events.readonly"),
        googleScope("drive.readonly"),
      ],
      "change-company": [],
      "reach-others": [googleScope("gmail.send")],
      "read-others": [],
    },
    // Modifying mail reads and sends it, and writing events reads them.
    // `drive.file` reads only Grasp's own files: it takes in no reading.
    implied: {
      [googleScope("gmail.modify")]: [
        googleScope("gmail.readonly"),
        googleScope("gmail.send"),
      ],
      [googleScope("calendar.events")]: [
        googleScope("calendar.events.readonly"),
      ],
    },
  },
});

/**
 * Native Google Workspace connector, on Google's APIs: Gmail of one
 * mailbox, one calendar, and the files and spreadsheets of one shared
 * drive, per call, and drafts in the person's own Drive.
 *
 * Scopes, the least each tool needs (its `scopes`): reading mail on
 * `gmail.readonly`, labelling and drafting it on `gmail.modify` (applying
 * labels needs it, and it can't delete for good), sending on
 * `gmail.send`; reading calendars on `calendar.events.readonly`, and
 * putting an event in the person's own on `calendar.events` (events only,
 * not calendar settings or sharing; calendar.ts holds writes to their own
 * calendar) with `calendar.calendarlist.readonly` (which calendar is
 * theirs); `drive.readonly` for shared drives' files (Sheets takes it to
 * read a spreadsheet's cells) and `drive.file` for drafts (only the files
 * this app made).
 *
 * It syncs the person's own Drive (drive-sync.ts), on `drive.readonly`,
 * mailbox (gmail-sync.ts), on `gmail.modify`, and primary calendar
 * (calendar-sync.ts), on `calendar.events`, for the Brain; and, on a
 * shared connection, the shared drives an admin picked
 * (shared-drive-sync.ts), on `drive.readonly`.
 */
export default withNativeSyncs(
  defineConnector({
    name: "google-workspace",
    provider: "google",
    title: "Google Workspace",
    auth: googleAuth,
    hosts: [gmailHost, apisHost, sheetsHost, "openidconnect.googleapis.com"],
    errors: googleErrors,
    tools: {
      ...gmailTools,
      ...calendarTools,
      ...driveTools,
      ...sheetsTools,
      ...draftTools,
    },
  }),
  [driveSync, gmailSync, calendarSync, sharedDriveSync]
);
