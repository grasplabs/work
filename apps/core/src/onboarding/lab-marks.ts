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
      en: "34a742c98863a6c87689be4f3881e12495a8f34f2de56c2d56401c5e284b813a",
      nl: "f522ab263b8a067e5ec1c830686f44e9322a0edc1049d8a4864015d1ba1737d0",
      de: "e3601c0dd80506be2859aabade62e2b68580369c5fc11e6b2fe3b30893741bfe",
      fr: "450be45d5a78be5b9126497a9a357f48bd7e80b3b3eb4bfae8bfbe02946afcfa",
      es: "df3406ccceb67983ba2c54d4f858019a565494ec922cafe2d9d2a414083c780e",
    },
    lead: {
      en: "688b5a772acd26200c01993d1c65f5d6700c44f5d0fbc733718ab59ae02082a8",
      nl: "454b9ddb5a2e16ced3a09a30c6f9de4fac34d7de33a71e59d50e10da0ec26306",
      de: "2da379a7384b7315f965231e9081602d807f95f7821072a24be514e0b76486ef",
      fr: "b3abd9540d312c1ebcbbeaac41d6474a5ac1ca661949f9c01e7c7c5b8f846004",
      es: "601c5b08c830fec2d1837abe8d98160be957677929b0aa9108cd4978da2c20c3",
    },
  },
  claire: {
    own: {
      en: "4208572e18f3d658a47a147cfa3bb9317d2bf9bf99e1f5fd239527ad183ebb8d",
      nl: "70a3efb0e9b8ae39e75a7292efa3e962c28e2e9b70d8693b2daa6b2f83bbc73c",
      de: "6a29e5a3075c061ca10376657b85f0c76e68c6b5e69659e198bfd959cf768f3f",
      fr: "9446784eecdb9119cdfae77960a629160914a29b9e088dc74b3337b7d17b0de5",
      es: "58868a14b4e4787d53bf629ce6b3dad4dbd2ca12973f2cbb635036c4baa7d138",
    },
    lead: {
      en: "7d60f6862f4c8cc07d2454c87f3dac02c07ae23443cd678440e06b3f0d2b234b",
      nl: "abeefad85440fcd8336a1f2ca4bf68ce45b617c75d33fb6288d60e4163c6f86a",
      de: "97d811841b44b6010ca5d410ee8ac11a4144b227d4bad97e1d749f5b8e5e4606",
      fr: "3191ba304ac8c266a6c7c4cb839fb9beb0c8a45b864bca4358d742e7828318b9",
      es: "b1195164a2f2c264be45976dcb12f1ae7f95448db472b78e36c0434a89cddd8a",
    },
  },
};

// Which Stephen this is, as one name for all of the marks above: the first
// twelve hex digits of the SHA-256 of every mark, in the order they stand
// here, one to a line. It changes whenever any text does, so an interview
// that keeps it says which texts held it, in whatever language it ran, and
// the Stephen Lab sets the interviews of one version beside its runs. A
// test holds it to the marks.
export const stephenVersion = "866527574350";

/** Every mark above, in the order they stand: what `stephenVersion` is taken over. */
export const everyLabMark = (): string[] =>
  Object.values(labMarks).flatMap((kinds) =>
    Object.values(kinds).flatMap((locales) => Object.values(locales))
  );
