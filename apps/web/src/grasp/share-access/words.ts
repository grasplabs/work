// Share access's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `…Label` props still win until the breaking release's step 5.
export const shareAccessWords = {
  /** The add field's name and placeholder. */
  find: "Add people or groups",
  /** The name of the access chosen for who you add. */
  inviteLevel: "Access for who you add",
  /** The invite button. */
  invite: "Invite",
  /** Said when an invite failed. */
  failedInvite: "Could not invite",
  /** The list's name. */
  list: "People with access",
  /** The owner's access, which cannot change. */
  owner: "Owner",
  /** After the viewer's own name. */
  you: "(you)",
  /** The name of a member's access, from their name. */
  level: (name: string) => `Access for ${name}`,
  /** The remove button, at a row's end. */
  remove: "Remove",
  /** The preview's name. */
  preview: "What they will see",
  /** The link button. */
  copyLink: "Copy link",
  /** Said on the link button once it copied. */
  copied: "Link copied",
  /** Said on the link button when it could not copy. */
  copyFailed: "Could not copy",
  /** The close button. */
  done: "Done",
};

export type ShareAccessWords = typeof shareAccessWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    shareAccess: ShareAccessWords;
  }
}
