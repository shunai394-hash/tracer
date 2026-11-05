export type FishAudioApprovedCustomVoice = {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
  category: "friend_clone" | "acquaintance_clone" | "special_character";
  gender: "female" | "male";
  useCase: string;
  source: "user_supplied_clone";
  approvalStatus: "user_confirmed";
};

// User confirmed that the relevant voice owners have authorized cloning and use.
// These entries are kept separate from Fish Audio's public licensed voice catalogue.
export const APPROVED_CUSTOM_FISH_VOICES: FishAudioApprovedCustomVoice[] = [
  {
    id: "08b96e6bbf1d4c978d4bfaa2f6e82179",
    title: "友人クローン（女性）",
    description: "本人許可確認済み。女性クローン音声。",
    languages: ["ja"],
    tags: ["女性", "友人クローン"],
    category: "friend_clone",
    gender: "female",
    useCase: "AIライブ販売員・女性ボイス",
    source: "user_supplied_clone",
    approvalStatus: "user_confirmed",
  },
  {
    id: "0839163163a84ce5b9919a1681ce156a",
    title: "友人クローン（男性・ライブ）",
    description: "本人許可確認済み。男性ライブ用クローン音声。",
    languages: ["ja"],
    tags: ["男性", "ライブ", "友人クローン"],
    category: "friend_clone",
    gender: "male",
    useCase: "AIライブ販売員・男性ライブ音声",
    source: "user_supplied_clone",
    approvalStatus: "user_confirmed",
  },
  {
    id: "4df0df091e0642c1b124488caa06ce6b",
    title: "知り合いクローン（女性）",
    description: "本人許可確認済み。女性クローン音声。",
    languages: ["ja"],
    tags: ["女性", "知り合いクローン"],
    category: "acquaintance_clone",
    gender: "female",
    useCase: "AIライブ販売員・女性ボイス",
    source: "user_supplied_clone",
    approvalStatus: "user_confirmed",
  },
  {
    id: "8f99ad75c8184f1db0c21d3a906445a4",
    title: "士道（レン役・特殊男性声）",
    description: "本人許可確認済み。レン役の特殊男性音声。",
    languages: ["ja"],
    tags: ["男性", "特殊音声", "レン役", "士道"],
    category: "special_character",
    gender: "male",
    useCase: "レン役・特殊キャラクター音声",
    source: "user_supplied_clone",
    approvalStatus: "user_confirmed",
  },
];
