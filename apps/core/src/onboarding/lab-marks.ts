import type {
  InterviewKind,
  InterviewLocale,
  Interviewer,
} from "@grasp-os/shared/onboarding";

// The marks of the texts the Stephen Lab measures (interviewer-text.ts),
// one per interviewer, kind of interview and language: the text on the
// prototype's main at 48534d4 (grasplabs/prototype, packages/grasp), after
// the lab's round of 5 October and the interview's audit of the same day,
// then the handover to a named colleague and the promise about whose words
// are seen (GRA-1285, GRA-1286), and that promise again once each line has
// a destination (GRA-1987), marked from core's text without a lab round.
// Core speaks only a text whose mark is here, and a test holds it to that:
// a text changes only through the lab, one change at a time, and its new
// marks come in with the change the lab kept.
export const labMarks: Record<
  Interviewer,
  Record<InterviewKind, Record<InterviewLocale, string>>
> = {
  stephen: {
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
  },
  claire: {
    own: {
      en: "8e070ad25a7336c910e51e9a34e739787b0ee3a3be9f2c2ed6609aaf78186a49",
      nl: "bcc4f7754be4bcbe152224f0c1c60967012096a70429c4e7b877917e8607781a",
      de: "e40ad75afd22f61643078fcb1842f684a6955cc43ae494fa11650f3b71513012",
      fr: "3bdb80d666f140e3040e06caabf1f9aac20622a1fb6a4d721333109364c59ff4",
      es: "acb2750cb6ec559bb3e56901086487b31888ec63885ad271a83df133ba0c6224",
    },
    lead: {
      en: "7b3f118716f6686fd4ec378a571f0d5e62dd90214ca87a777d8c2ed808a05e79",
      nl: "c15066f84dceec94f526f7e0d39337a8673d6bf39789ad63d10753061f15911e",
      de: "2e2fffb42cf5a9c96a321ca90f15f71a9a97bdd9d1248d055086089cbd2fd2e5",
      fr: "b66baff73cbce1ae5db0cc95c0367bb593f52415970427c97c90786114bd4d56",
      es: "cbe850ede2ee917680ad8bf5feb80f899a32c1e0d0497ad036c731b874afccd9",
    },
  },
};

// Which Stephen this is, as one name for all of the marks above: the first
// twelve hex digits of the SHA-256 of every mark, in the order they stand
// here, one to a line. It changes whenever any text does, so an interview
// that keeps it says which texts held it, in whatever language it ran, and
// the Stephen Lab sets the interviews of one version beside its runs. A
// test holds it to the marks.
export const stephenVersion = "adbc69f1429e";

/** Every mark above, in the order they stand: what `stephenVersion` is taken over. */
export const everyLabMark = (): string[] =>
  Object.values(labMarks).flatMap((kinds) =>
    Object.values(kinds).flatMap((locales) => Object.values(locales))
  );
