import type {
  InterviewKind,
  InterviewLocale,
} from "@grasp-os/shared/onboarding";

// The marks of the texts the Stephen Lab measures (interviewer-text.ts),
// one per kind of interview and language: the text on the
// prototype's main at 48534d4 (grasplabs/prototype, packages/grasp), after
// the lab's round of 5 October and the interview's audit of the same day,
// then the handover to a named colleague and the promise about whose words
// are seen (GRA-1285, GRA-1286), and that promise again once each line has
// a destination (GRA-1987), marked from core's text without a lab round.
// Core speaks only a text whose mark is here, and a test holds it to that:
// a text changes only through the lab, one change at a time, and its new
// marks come in with the change the lab kept.
export const labMarks: Record<
  InterviewKind,
  Record<InterviewLocale, string>
> = {
  own: {
    en: "0a48c0d373f75127d6fd0cf56f12b51e1d7f9df19dbd4b9ba39b9a72320f39c9",
    nl: "c739a767f5e8943a84bd9a2d346b97dff2de69733a2d334672d4706dde4522a2",
    de: "d6baf10798c8c909c36eeca5c1490aa04c0f195b64dd276712a5be4e324b4820",
    fr: "f715f13f983a149fa37c4a4aa906890960790465866ad289b5f267a190f0dda1",
    es: "d8ae32cc0493abdac23d5d21d6abfb14319e6acb12dc1f0ad8c9b22f7c0fce73",
  },
  lead: {
    en: "c19156e24d2f53c686c07cce92a71b06b2cce99c137ccb26911b8329216b5cc0",
    nl: "4ec6c724f71e8cfa4c5b9490ed90304378d41246958dc938d55b189f75536e57",
    de: "4741e21e28e4880fd5a9d44d566b4c10d1af7fe42730d7cbbe3cff42985c15ab",
    fr: "408cf81707d1f9257abb9456ad03934b0ad5515c13e0a37d37d959723a39fd13",
    es: "49b47acbb06fe5199a7a6707f12b78d91c4d4bce9eb0678ab6ce7f91690de756",
  },
};

// Which Stephen this is, as one name for all of the marks above: an
// interview that keeps it says which texts held it, in whatever language
// it ran, and the Stephen Lab sets the interviews of one version beside
// its runs. These texts got this name while a second interviewer's marks
// stood beside them, and it was taken over hers too. Her texts went and
// his did not change, so he keeps the name: the interviews and the runs
// kept under it stay his. With the next change to a text the version is
// named after the marks again: it becomes the new `marksDigest`.
export const stephenVersion = "adbc69f1429e";

// The marks above as one: the first twelve hex digits of the SHA-256 of
// every mark, in the order they stand here, one to a line. A test holds it
// to the marks, so no text changes under a version's name: whoever changes
// a mark changes this, and gives `stephenVersion` this as its new name.
export const marksDigest = "4c045da79e69";

/** Every mark above, in the order they stand: what `marksDigest` is taken over. */
export const everyLabMark = (): string[] =>
  Object.values(labMarks).flatMap((locales) => Object.values(locales));
