// Copies of a credential an API echoes back, replaced before what it
// answered reaches an App or a connector: http-connections.ts and egress.ts.

/** What every copy of the credential an API echoes back is replaced with. */
const credentialPlaceholder = "[credential]";

/**
 * The forms of the credential an API may echo it back in: as sent and
 * bare, each also as a JSON string escapes it, with `/` left as is or
 * escaped (`\\/`), as some encoders do. Longest first, so a longer form is
 * replaced whole before a shorter one inside it.
 */
export const credentialForms = (sentAs: readonly string[]): string[] => {
  const forms = new Set<string>();
  for (const value of sentAs) {
    const escaped = JSON.stringify(value).slice(1, -1);
    forms.add(value);
    forms.add(escaped);
    forms.add(escaped.replaceAll("/", "\\/"));
  }
  return [...forms].toSorted((one, other) => other.length - one.length);
};

/**
 * `text` with every copy of the credential `credentialForms` names
 * replaced, so an API that echoes its request back (a debugging endpoint,
 * an error that quotes the headers) doesn't hand it on as it is. Best
 * effort: an API can always encode it some other way (base64, URL
 * encoding, split across fields); what stops a leak is approving only an
 * API that is trusted with the credential.
 */
export const withoutCredential = (
  text: string,
  forms: readonly string[]
): string => {
  let replaced = text;
  for (const form of forms) {
    replaced = replaced.replaceAll(form, credentialPlaceholder);
  }
  return replaced;
};
