// Edge Function: player-profile
// Manages per-device adaptive PlayerProfile rows used to tune online bots.
//
// Deploy:  supabase functions deploy player-profile --no-verify-jwt
//
// Actions (POST body { fn, data }):
//   - "get"            { deviceId }                        -> { profile }
//   - "track"          { deviceId, events: ProfileEvent[] } -> { profile }
//   - "set_difficulty" { deviceId, difficulty }            -> { ok: true }
//   - "set_honesty"    { deviceId, honesty }               -> { ok: true }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function makeCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response: Response, req: Request) {
  const headers = new Headers(response.headers);
  const cors = makeCorsHeaders(req);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type ProfileEvent =
  | { type: "game_started" }
  | { type: "envit_called"; strength: number; bluff: boolean }
  | { type: "truc_called"; strength: number; bluff: boolean }
  | { type: "envit_response"; accepted: boolean }
  | { type: "truc_response"; accepted: boolean };

interface ProfileRow {
  device_id: string;
  games_played: number;
  envit_called: number;
  envit_called_bluff: number;
  envit_accepted: number;
  envit_rejected: number;
  envit_strength_sum: number;
  envit_strength_n: number;
  truc_called: number;
  truc_called_bluff: number;
  truc_accepted: number;
  truc_rejected: number;
  truc_strength_sum: number;
  truc_strength_n: number;
  aggressiveness: number;
  bluff_rate: number;
  accept_threshold: number;
  bot_difficulty: string;
  bot_honesty: string;
  created_at?: string;
  updated_at?: string;
}

type CanonicalHonesty = "honest" | "bluffer" | "liar";

function normalizeHonesty(value: unknown): CanonicalHonesty | null {
  const honesty = String(value ?? "").trim().toLowerCase();
  const aliases: Record<string, CanonicalHonesty> = {
    honest: "honest",
    honesto: "honest",
    honesta: "honest",
    sincer: "honest",
    sincero: "honest",
    sincera: "honest",
    normal: "honest",
    high: "honest",
    bluffer: "bluffer",
    farolero: "bluffer",
    farolera: "bluffer",
    pillo: "bluffer",
    pilla: "bluffer",
    liar: "liar",
    mentider: "liar",
    mentidera: "liar",
    mentiroso: "liar",
    mentirosa: "liar",
    low: "liar",
  };
  return aliases[honesty] ?? null;
}

function emptyRow(deviceId: string): ProfileRow {
  return {
    device_id: deviceId,
    games_played: 0,
    envit_called: 0,
    envit_called_bluff: 0,
    envit_accepted: 0,
    envit_rejected: 0,
    envit_strength_sum: 0,
    envit_strength_n: 0,
    truc_called: 0,
    truc_called_bluff: 0,
    truc_accepted: 0,
    truc_rejected: 0,
    truc_strength_sum: 0,
    truc_strength_n: 0,
    aggressiveness: 0.5,
    bluff_rate: 0.15,
    accept_threshold: 0.5,
    bot_difficulty: "balanced",
    bot_honesty: "honest",
  };
}

function recompute(row: ProfileRow): ProfileRow {
  const calls = row.envit_called + row.truc_called;
  const games = Math.max(1, row.games_played);
  // Aggressiveness ~ calls per game, soft-capped to [0..1].
  const callsPerGame = calls / games;
  row.aggressiveness = Math.max(0, Math.min(1, callsPerGame / 4));

  const bluffN = row.envit_called_bluff + row.truc_called_bluff;
  row.bluff_rate = calls > 0 ? Math.max(0, Math.min(1, bluffN / calls)) : 0.15;

  const responses =
    row.envit_accepted + row.envit_rejected + row.truc_accepted + row.truc_rejected;
  const accepted = row.envit_accepted + row.truc_accepted;
  row.accept_threshold = responses > 0
    ? Math.max(0, Math.min(1, accepted / responses))
    : 0.5;
  return row;
}

function applyEvent(row: ProfileRow, ev: ProfileEvent): ProfileRow {
  switch (ev.type) {
    case "game_started":
      row.games_played += 1;
      break;
    case "envit_called":
      row.envit_called += 1;
      if (ev.bluff) row.envit_called_bluff += 1;
      if (typeof ev.strength === "number" && isFinite(ev.strength)) {
        row.envit_strength_sum += ev.strength;
        row.envit_strength_n += 1;
      }
      break;
    case "truc_called":
      row.truc_called += 1;
      if (ev.bluff) row.truc_called_bluff += 1;
      if (typeof ev.strength === "number" && isFinite(ev.strength)) {
        row.truc_strength_sum += ev.strength;
        row.truc_strength_n += 1;
      }
      break;
    case "envit_response":
      if (ev.accepted) row.envit_accepted += 1;
      else row.envit_rejected += 1;
      break;
    case "truc_response":
      if (ev.accepted) row.truc_accepted += 1;
      else row.truc_rejected += 1;
      break;
  }
  return row;
}

async function loadOrInit(deviceId: string): Promise<ProfileRow> {
  const { data, error } = await supabase
    .from("player_profiles")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as ProfileRow;
  const row = emptyRow(deviceId);
  const { error: insErr } = await supabase.from("player_profiles").insert(row);
  if (insErr && !String(insErr.message).includes("duplicate")) throw insErr;
  return row;
}

function toProfile(row: ProfileRow) {
  return {
    device_id: row.device_id,
    games_played: row.games_played,
    aggressiveness: row.aggressiveness,
    bluff_rate: row.bluff_rate,
    accept_threshold: row.accept_threshold,
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return withCors(new Response("ok", { status: 200 }), req);
  }
  if (req.method !== "POST") {
    return withCors(json({ error: "Method not allowed" }, 405), req);
  }

  let body: { fn?: string; data?: any } | null = null;
  try {
    body = await req.json();
  } catch (err) {
    return withCors(
      json({ error: `Invalid JSON body: ${(err as Error)?.message ?? "parse error"}` }, 400),
      req,
    );
  }

  try {
    if (!body || typeof body.fn !== "string") {
      return withCors(json({ error: "Bad request: missing 'fn'" }, 400), req);
    }
    const { fn, data } = body;
    const deviceId = String(data?.deviceId ?? "");
    if (!deviceId) {
      return withCors(json({ error: "deviceId required" }, 400), req);
    }

    if (fn === "get") {
      const row = await loadOrInit(deviceId);
      return withCors(json({ profile: toProfile(row) }), req);
    }

    if (fn === "track") {
      const events: ProfileEvent[] = Array.isArray(data?.events) ? data.events : [];
      let row = await loadOrInit(deviceId);
      for (const ev of events) row = applyEvent(row, ev);
      row = recompute(row);
      row.updated_at = new Date().toISOString();
      const { error } = await supabase
        .from("player_profiles")
        .update({
          games_played: row.games_played,
          envit_called: row.envit_called,
          envit_called_bluff: row.envit_called_bluff,
          envit_accepted: row.envit_accepted,
          envit_rejected: row.envit_rejected,
          envit_strength_sum: row.envit_strength_sum,
          envit_strength_n: row.envit_strength_n,
          truc_called: row.truc_called,
          truc_called_bluff: row.truc_called_bluff,
          truc_accepted: row.truc_accepted,
          truc_rejected: row.truc_rejected,
          truc_strength_sum: row.truc_strength_sum,
          truc_strength_n: row.truc_strength_n,
          aggressiveness: row.aggressiveness,
          bluff_rate: row.bluff_rate,
          accept_threshold: row.accept_threshold,
          updated_at: row.updated_at,
        })
        .eq("device_id", deviceId);
      if (error) throw error;
      return withCors(json({ profile: toProfile(row) }), req);
    }

    if (fn === "set_difficulty") {
      const difficulty = String(data?.difficulty ?? "");
      if (!["balanced", "aggressive", "conservative"].includes(difficulty)) {
        return withCors(json({ error: "invalid difficulty" }, 400), req);
      }
      await loadOrInit(deviceId);
      const { error } = await supabase
        .from("player_profiles")
        .update({ bot_difficulty: difficulty, updated_at: new Date().toISOString() })
        .eq("device_id", deviceId);
      if (error) throw error;
      return withCors(json({ ok: true }), req);
    }

    if (fn === "set_honesty") {
      const honesty = normalizeHonesty(data?.honesty ?? data?.bot_honesty);
      if (!honesty) {
        return withCors(json({ error: "invalid honesty" }, 400), req);
      }
      await loadOrInit(deviceId);
      const { error } = await supabase
        .from("player_profiles")
        .update({ bot_honesty: honesty, updated_at: new Date().toISOString() })
        .eq("device_id", deviceId);
      if (error) throw error;
      return withCors(json({ ok: true }), req);
    }

    return withCors(json({ error: `unknown fn: ${fn}` }, 404), req);
  } catch (err) {
    const e = err as any;
    const payload = {
      error: e?.message ?? "internal error",
      code: e?.code,
      details: e?.details,
      hint: e?.hint,
      fn: body?.fn,
    };
    console.error("player-profile error:", payload);
    return withCors(json(payload, 500), req);
  }
});