// Backend-only minimal copy of phrases.ts. The Edge Function only needs the
// ChatPhraseId type to validate `sendChatPhrase` payloads and to satisfy the
// `import type { ChatPhraseId } from "./phrases"` in botConsult.ts.
// The client-side translation helpers are NOT included here.

export type ChatPhraseId =
  | "puc-anar"
  | "vine-a-mi"
  | "vine-a-vore"
  | "a-tu"
  | "tens-mes-dun-tres"
  | "portes-un-tres"
  | "vine-al-meu-tres"
  | "vine-al-teu-tres"
  | "tinc-un-tres"
  | "tinc-bona"
  | "que-tens"
  | "tens-envit"
  | "vols-envide"
  | "vols-tornar-envidar"
  | "quant-envit"
  | "si"
  | "si-tinc-n"
  | "no"
  | "envida"
  | "tira-falta"
  | "pon-fort"
  | "pon-molesto"
  | "truca"
  | "juega-callado"
  | "vamonos"
  | "no-tinc-res";

export const PHRASE_IDS: ChatPhraseId[] = [
  "puc-anar", "vine-a-mi", "vine-a-vore", "a-tu",
  "tens-mes-dun-tres", "portes-un-tres", "vine-al-meu-tres", "vine-al-teu-tres",
  "tinc-un-tres", "tinc-bona", "que-tens",
  "tens-envit", "vols-envide", "vols-tornar-envidar", "quant-envit",
  "si", "si-tinc-n", "no",
  "envida", "tira-falta", "pon-fort", "pon-molesto", "truca",
  "juega-callado", "vamonos", "no-tinc-res",
];