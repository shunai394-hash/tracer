export type FishAudioCustomVoice = {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
  source: "user_provided_clone";
  consentStatus: "confirmed";
  category: "female_friend" | "male_live_friend" | "female_acquaintance" | "special_ren_role";
};

/**
 * User-supplied private clone references. These are deliberately kept separate
 * from Fish Audio's public/licensed catalogue and are never labelled public.
 * Consent for cloning and TRACER audio generation was explicitly confirmed
 * by the account owner before enabling these entries.
 */
export const CONSENTED_CUSTOM_JAPANESE_VOICES: FishAudioCustomVoice[] = [
  {
    id: "08b96e6bbf1d4c978d4bfaa2f6e82179",
    title: "友人クローン（女性）",
    description: "本人許可済みのカスタム音声。友人女性ボイス。",
    languages: ["ja"],
    tags: ["女性", "友人", "カスタムクローン"],
    source: "user_provided_clone",
    consentStatus: "confirmed",
    category: "female_friend",
  },
  {
    id: "0839163163a84ce5b9919a1681ce156a",
    title: "友人クローン（男性・ライブ）",
    description: "本人許可済みのカスタム音声。男性ライブ販売員向け。",
    languages: ["ja"],
    tags: ["男性", "友人", "ライブ", "カスタムクローン"],
    source: "user_provided_clone",
    consentStatus: "confirmed",
    category: "male_live_friend",
  },
  {
    id: "4df0df091e0642c1b124488caa06ce6b",
    title: "知り合いクローン（女性）",
    description: "本人許可済みのカスタム音声。女性ボイス。",
    languages: ["ja"],
    tags: ["女性", "知り合い", "カスタムクローン"],
    source: "user_provided_clone",
    consentStatus: "confirmed",
    category: "female_acquaintance",
  },
  {
    id: "8f99ad75c8184f1db0c21d3a906445a4",
    title: "士道（男性・特殊音声／レン役）",
    description: "本人許可済みのカスタム音声。特殊音声・レン役。",
    languages: ["ja"],
    tags: ["男性", "特殊音声", "レン役", "カスタムクローン"],
    source: "user_provided_clone",
    consentStatus: "confirmed",
    category: "special_ren_role",
  },
];

export function getConsentedCustomJapaneseVoices(): FishAudioCustomVoice[] {
  return CONSENTED_CUSTOM_JAPANESE_VOICES.map((voice) => ({ ...voice, languages: [...voice.languages], tags: [...voice.tags] }));
}

export function isConsentedCustomJapaneseVoice(referenceId: string): boolean {
  return CONSENTED_CUSTOM_JAPANESE_VOICES.some((voice) => voice.id === referenceId && voice.consentStatus === "confirmed");
}
