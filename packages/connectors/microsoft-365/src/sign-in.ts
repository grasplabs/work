import { auth } from "@grasp-os/sdk/connector";

const login = "https://login.microsoftonline.com";

/**
 * Signing in to Microsoft 365: Entra ID's v2 endpoints for the
 * organization's own tenant, so the sign-in page offers only its accounts.
 * Entra answers the code in the query by default, so no `response_mode` is
 * needed. It has no token revocation endpoint: disconnecting deletes the
 * tokens, and they lapse.
 *
 * The account is the ID token's `oid`, in the organization's tenant
 * (`tid`, and the issuer naming it), for Grasp's own client; a B2B guest,
 * signed in by another tenant (`idp`), is refused.
 *
 * A consent asks only the rights of the classes a company turned on, and
 * turning a class on asks the connections that lack its rights to connect
 * again. Reading the person's own is reading their mailbox (and its
 * categories), calendar, OneDrive and OneNote; changing it, writing them
 * (drafts, flags, events, their own documents, their To Do, their notes).
 * The company's is SharePoint, others' calendars and the Planner plans of
 * the person's groups, and reaching others is sending mail. Reading
 * others' words is the person's own Teams chats and the transcripts of the
 * meetings they were in, found through their calendar. A shared mailbox's
 * rights come with pointing Stephen at one.
 */
export const signIn = auth.oauth2({
  authorizeUrl: `${login}/{tenant}/oauth2/v2.0/authorize`,
  tokenUrl: `${login}/{tenant}/oauth2/v2.0/token`,
  scopes: {
    openid: "Sign you in",
    profile: "Read your name",
    email: "Read your address",
    offline_access: "Stay signed in",
    "User.Read": "Read your profile and the groups you're in",
    "Mail.Read": "Read your mail",
    "Mail.ReadWrite": "Change your mail",
    "Mail.ReadWrite.Shared":
      "Read and change mail in mailboxes shared with you",
    "Mail.Send": "Send mail as you",
    "Mail.Send.Shared": "Send mail from mailboxes shared with you",
    "MailboxSettings.Read": "Read your mail categories",
    "Calendars.Read": "Read your calendar",
    "Calendars.ReadWrite": "Change your calendar",
    "Calendars.Read.Shared": "Read calendars shared with you",
    "Files.Read": "Read your files",
    "Files.Read.All": "Read the files you can open",
    "Files.ReadWrite.All": "Change the files you can change",
    "Sites.Read.All": "Read SharePoint sites you can open",
    "Sites.ReadWrite.All": "Change SharePoint lists you can change",
    "Tasks.Read": "Read your tasks and your groups' plans",
    "Tasks.ReadWrite": "Change your tasks and your groups' plans",
    "Notes.Read": "Read your notes",
    "Notes.ReadWrite": "Change your notes",
    "Chat.Read": "Read your Teams chats",
    "OnlineMeetings.Read": "Read your Teams meetings",
    "OnlineMeetingTranscript.Read.All":
      "Read the transcripts of meetings you were in",
  },
  tenant: "guid",
  idToken: {
    issuer: `${login}/{tenant}/v2.0`,
    subject: "oid",
    name: ["preferred_username"],
    email: ["email", "preferred_username"],
    claims: { tid: "{tenant}" },
    sameIssuer: ["idp"],
  },
  rights: {
    signIn: ["openid", "profile", "email", "offline_access", "User.Read"],
    classes: {
      "read-own": [
        "Mail.Read",
        "MailboxSettings.Read",
        "Calendars.Read",
        "Files.Read",
        "Notes.Read",
      ],
      "change-own": [
        "Mail.ReadWrite",
        "Calendars.ReadWrite",
        "Files.ReadWrite.All",
        "Tasks.ReadWrite",
        "Notes.ReadWrite",
      ],
      "read-company": [
        "Files.Read.All",
        "Sites.Read.All",
        "Calendars.Read.Shared",
        "Tasks.Read",
      ],
      "change-company": [
        "Files.ReadWrite.All",
        "Sites.ReadWrite.All",
        "Tasks.ReadWrite",
      ],
      "reach-others": ["Mail.Send"],
      "read-others": [
        "Calendars.Read",
        "Chat.Read",
        "OnlineMeetings.Read",
        "OnlineMeetingTranscript.Read.All",
      ],
    },
    // Writing reads, and a right on every file the person can open covers
    // their own.
    implied: {
      "Mail.ReadWrite": ["Mail.Read"],
      "Calendars.ReadWrite": ["Calendars.Read"],
      "Files.ReadWrite.All": [
        "Files.ReadWrite",
        "Files.Read.All",
        "Files.Read",
      ],
      "Files.ReadWrite": ["Files.Read"],
      "Files.Read.All": ["Files.Read"],
      "Sites.ReadWrite.All": ["Sites.Read.All"],
      "Tasks.ReadWrite": ["Tasks.Read"],
      "Notes.ReadWrite": ["Notes.Read"],
    },
    sharedMailbox: {
      read: ["Mail.ReadWrite.Shared"],
      reach: ["Mail.Send.Shared"],
    },
  },
  // Entra may name a Graph scope by its full URI in a token's answer.
  scopePrefix: "https://graph.microsoft.com/",
});
