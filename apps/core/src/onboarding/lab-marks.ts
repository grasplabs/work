import type {
  InterviewKind,
  InterviewLocale,
  Interviewer,
} from "@grasp-os/shared/onboarding";

// The marks of the texts the Stephen Lab measures (interviewer-text.ts),
// one per interviewer, kind of interview and language: the text on the
// prototype's main at 48534d4 (grasplabs/prototype, packages/grasp), after
// the lab's round of 5 October and the interview's audit of the same day,
// with the handover to a named colleague (8c7e1ff4, 15 October) and the
// promise about whose words are seen (af8e34c1, 16 October).
// Core speaks only a text whose mark is here, and a test holds it to that:
// a text changes only through the lab, one change at a time, and its new
// marks come in with the change the lab kept.
export const labMarks: Record<
  Interviewer,
  Record<InterviewKind, Record<InterviewLocale, string>>
> = {
  stephen: {
    own: {
      en: "76a5d9ed59b7d24fecaf6897b2bb450b4d0893aadd06cd9291e68a3adc63eb85",
      nl: "a7c965a1d750aa396e77e8f25539f243eecb8232e462fbd95112893ab7df3c49",
      de: "88c24f80df5bc08b6c00d6bb23a6f5da564b10408de550ca09fa37fa2b38bff9",
      fr: "848ca68f5524ed6bf8cfa9b3806c8ee20964bda3ca1ace93c05007f139d7a5e6",
      es: "b3336e76c49fb6b973a447d90a2efc20cdcbfb1302a95c7c4aceca5fc435670f",
    },
    lead: {
      en: "d238af3f8de94ad37189363f341d63f6f546fee177d9c60d788a350a063a2bd7",
      nl: "5ca515561995f10be29e8786a87320e483627ed08a2a3abba3bddb88a73edcf2",
      de: "590054b30680bd9326b65ae052c4583f6612366a6f9dc8d3590a220bbff95697",
      fr: "9751ee09c7c31f19a6c138eac219493b79f7b0af1e6ee1ead0130a8ad5756db0",
      es: "713c4899ecf45f556b6f979af8fe349ee17e68dd20aedd25d48ba4d724404e15",
    },
  },
  claire: {
    own: {
      en: "0a59f54cc0140eeaa0337a703678ec216ec9b65533d6922568d958933cf4affe",
      nl: "0150b2ea2a7efd83ee15022d93c791b5ba327b5ddf159a33d1528268d69cccd6",
      de: "544f88250f19a45cc0bc1895e4d4e7fd825aadb28e36f386f4306a701e87de0d",
      fr: "ba2e34c22a41807a3cf07bb0aa053dc9491c2598b185d788bdd3740275824d3c",
      es: "9016e9a067de5c428f7236c7b2567ec8ee4c51ab5f809adad3c86bc4224dd1d0",
    },
    lead: {
      en: "6044edd8be8d1c8a2b5cbd1088abc17394ef64d10c86bf15ae1caf769cbfbeba",
      nl: "2ad1b9c4010cb8d1d5352c19750605ba2bb737367129c3aeb277dd89870c159b",
      de: "f526a5fd3c17bc11968d707892085e5373357887388b33e6fd751bc916f7bb7e",
      fr: "10c1d1607803c1c9927218553b7dca3d7102f7944790c4153ce77db67acb9d68",
      es: "b7dd1a8465cb0f8b269fa9853ca82926b4c835dc04879d77ddb613d426aa5af5",
    },
  },
};
