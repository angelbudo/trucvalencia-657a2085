/**
 * Filtre de paraules malsonants per al xat online.
 *
 * La llista de paraules viu a la taula `public.blacklist` de Supabase
 * (l'administrador pot afegir/eliminar paraules des del panell).
 * En aquest mòdul mantenim:
 *
 *   1. Una llista per defecte (fallback) per si Supabase no està
 *      disponible o encara no s'ha carregat la primera resposta.
 *   2. Una funció `loadBlacklistFromSupabase()` que cal cridar a
 *      l'inici del xat per refrescar la llista des de la BD.
 *
 * La detecció és tolerant a accents, majúscules i caràcters repetits
 * (p.ex. "puuuta"). Si la paraula trobada està a `MASK_WITH_GAME_WORD`
 * (les més "lleus") la substituïm de manera rotativa per un joc
 * d'expressions del Truc; la resta es substitueixen per asteriscs.
 */

import { supabase } from "@/integrations/supabase/client";

const DEFAULT_BAD_WORDS: string[] = [
  // Castellà
  "puta", "putas", "puto", "putos",
  "gilipollas", "gilipuertas",
  "cabron", "cabrones", "cabrona",
  "hijoputa", "hijodeputa", "hdp",
  "mierda", "mierdas",
  "joder", "jodete",
  "coño", "cono",
  "polla", "pollas",
  "follar", "follate",
  "maricon", "maricones",
  "zorra", "zorras",
  "imbecil", "imbeciles",
  "idiota", "idiotas",
  "subnormal", "subnormales",
  "estupido", "estupida",
  "tonto", "tonta",
  "capullo", "capullos",
  "panoli",
  "retrasado", "retrasada",
  // Valencià / català
  "fillputa", "fillsdeputa", "fillputes",
  "cabro", "cabrons",
  "merda", "merdes",
  "collons",
  "punyeta", "punyetes",
  "carall",
  "imbecils",
  "estupit",
  "ximple", "ximplos",
  "tarat", "tarats",
  "burro", "burros",
  "amaricat",
];

/**
 * Només interjeccions/exclamacions lleus es substitueixen per una
 * expressió del Truc. Els insults greus i obscenitats (puta, polla,
 * gilipollas, cabron, maricon, zorra, fillputa, etc.) cauen sempre a
 * la branca d'asteriscs perquè no tenen sentit com a exclamació.
 */
const MASK_WITH_GAME_WORD = new Set<string>([
  // Castellà — exclamacions
  "joder", "jodete",
  "mierda", "mierdas",
  "coño", "cono",
  // Valencià / català — exclamacions
  "merda", "merdes",
  "collons", "carall",
  "punyeta", "punyetes",
]);

const GAME_REPLACEMENTS = ["¡Xe!", "¡Redeu!", "¡Recoranta!", "¡Reganxet!", "¡Che!"];

function stringHash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function seededRandom(seed: string): number {
  return (stringHash(seed) % 100000) / 100000;
}

function getGameWordForSeed(seed: string): string {
  const idx = Math.floor(seededRandom(seed) * GAME_REPLACEMENTS.length);
  return GAME_REPLACEMENTS[idx % GAME_REPLACEMENTS.length];
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Construeix un patró que tolera lletres repetides i diacrítics. */
function buildPattern(word: string): RegExp {
  const norm = stripDiacritics(word.toLowerCase());
  const body = Array.from(norm).map((ch) => {
    if (!/[a-z]/.test(ch)) return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `${ch}+`;
  }).join("");
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${body})(?=$|[^\\p{L}\\p{N}])`, "giu");
}

type Pattern = { raw: string; rx: RegExp };

function buildPatterns(words: ReadonlyArray<string>): Pattern[] {
  const seen = new Set<string>();
  const out: Pattern[] = [];
  for (const raw of words) {
    const key = stripDiacritics(raw.trim().toLowerCase());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: key, rx: buildPattern(key) });
  }
  return out;
}

let PATTERNS: ReadonlyArray<Pattern> = buildPatterns(DEFAULT_BAD_WORDS);

/** Substitueix la llista de patrons en runtime (usat per la càrrega des de Supabase). */
export function setBlacklistWords(words: ReadonlyArray<string>): void {
  if (!words || words.length === 0) return;
  PATTERNS = buildPatterns(words);
}

let _loadPromise: Promise<void> | null = null;

/**
 * Carrega la llista negra des de la taula `public.blacklist` de Supabase.
 * És idempotent: si ja s'ha cridat, retorna la mateixa promesa.
 */
export function loadBlacklistFromSupabase(): Promise<void> {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      // La taula `blacklist` es crea manualment al SQL editor; els tipus
      // generats encara no la coneixen, per això fem servir un cast.
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => {
          select: (cols: string) => Promise<{
            data: Array<{ word: string | null }> | null;
            error: { message: string } | null;
          }>;
        };
      })
        .from("blacklist")
        .select("word");
      if (error) {
        console.warn("[profanityFilter] no s'ha pogut carregar la blacklist:", error.message);
        return;
      }
      const words = (data ?? [])
        .map((r) => (r?.word ?? "").trim())
        .filter((w) => w.length > 0);
      if (words.length > 0) setBlacklistWords(words);
    } catch (err) {
      console.warn("[profanityFilter] error inesperat carregant la blacklist:", err);
    }
  })();
  return _loadPromise;
}

/**
 * Substitueix totes les paraules malsonants del text. La comparació
 * s'aplica sobre la versió sense diacrítics, però es preserva la posició
 * i els caràcters de separació originals.
 */
export function filterProfanity(text: string, seed?: string): string {
  if (!text) return text;
  let out = text;
  for (const { raw, rx } of PATTERNS) {
    out = out.replace(rx, (_match, pre: string, hit: string) => {
      const replacement = MASK_WITH_GAME_WORD.has(raw)
        ? getGameWordForSeed(seed ? `${seed}:${raw}` : raw)
        : "*".repeat(Math.max(3, hit.length));
      return `${pre}${replacement}`;
    });
  }
  return out;
}