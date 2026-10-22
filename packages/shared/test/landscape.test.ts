import { describe, expect, it } from "vite-plus/test";

import { isHighPrivilegeScope } from "../src/landscape.ts";

// Which scopes a person shouldn't give an app on their own: what the
// landscape's `person_high_privilege` signal is raised for.

describe("a high-privilege scope", () => {
  it("reaches mail, files, chats or calendars, or writes anyone's profile, a group or the directory; a person's own profile isn't one", () => {
    const scopes = [
      "Mail.Read",
      "Files.ReadWrite.All",
      "Chat.Read",
      "Calendars.ReadWrite",
      "Directory.ReadWrite.All",
      "User.ReadWrite.All",
      "Application.ReadWrite.OwnedBy",
      "RoleManagement.ReadWrite.Directory",
      "ChatMessage.Send",
      "Directory.AccessAsUser.All",
      "DelegatedPermissionGrant.ReadWrite.All",
      "AppRoleAssignment.ReadWrite.All",
      "GroupMember.ReadWrite.All",
      "MailboxSettings.ReadWrite",
      "User.ReadWrite",
      "User.Read",
      "User.ReadBasic.All",
      "offline_access",
      "openid",
    ];
    expect(scopes.filter(isHighPrivilegeScope)).toStrictEqual([
      "Mail.Read",
      "Files.ReadWrite.All",
      "Chat.Read",
      "Calendars.ReadWrite",
      "Directory.ReadWrite.All",
      "User.ReadWrite.All",
      "Application.ReadWrite.OwnedBy",
      "RoleManagement.ReadWrite.Directory",
      "ChatMessage.Send",
      "Directory.AccessAsUser.All",
      "DelegatedPermissionGrant.ReadWrite.All",
      "AppRoleAssignment.ReadWrite.All",
      "GroupMember.ReadWrite.All",
      "MailboxSettings.ReadWrite",
    ]);
  });
});
