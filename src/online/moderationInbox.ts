import { supabase } from "@/integrations/supabase/client";

type AppRole = "user" | "moderator" | "admin";

export type FlagStatus = "pending" | "approved" | "dismissed";
export type FlagDecision = FlagStatus | "forgiven";

export interface InboxFlag {
  id: number;
  roomId: string | null;
  roomName: string | null;
  targetDeviceId: string | null;
  reporterDeviceId: string | null;
  reason: string | null;
  messageId: number | null;
  messageText: string | null;
  status: FlagStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** local-blacklist | openai-moderation | <device id de l'usuari> */
  source: "local-blacklist" | "openai-moderation" | "user";
  /** Pes calculat a partir de reason (1=lleu, 2=greu). */
  weight: number;
  targetName: string | null;
  targetUsername: string | null;
  targetEmail: string | null;
}

export interface AuditEntry {
  id: number;
  flagId: number;
  roomId: string | null;
  roomName: string | null;
  targetDeviceId: string | null;
  reporterDeviceId: string | null;
  messageText: string | null;
  reason: string | null;
  decision: FlagDecision;
  decidedBy: string | null;
  moderatorTag: string | null;
  moderatorNote: string | null;
  decidedAt: string;
  targetName: string | null;
  targetUsername: string | null;
  targetEmail: string | null;
}

function weightFor(reason: string | null): number {
  if (!reason) return 1;
  const r = reason.toLowerCase();
  if (r.includes("llenguatge") || r.includes("amenaça") || r.includes("amenaza")) return 2;
  return 1;
}

function sourceFor(deviceId: string | null): InboxFlag["source"] {
  if (deviceId === "local-blacklist") return "local-blacklist";
  if (deviceId === "openai-moderation") return "openai-moderation";
  return "user";
}

async function resolveDeviceInfo(
  deviceIds: Array<string | null>,
): Promise<Map<string, { name: string | null; email: string | null; username: string | null }>> {
  const out = new Map<string, { name: string | null; email: string | null; username: string | null }>();
  const ids = Array.from(
    new Set(
      deviceIds.filter((d): d is string => !!d && d !== "local-blacklist" && d !== "openai-moderation"),
    ),
  );
  if (ids.length === 0) return out;
  try {
    // 1) Nom des de room_players (l'últim conegut).
    const nameByDevice = new Map<string, string | null>();
    try {
      const { data: rp } = await (supabase as any)
        .from("room_players")
        .select("device_id, name, last_seen")
        .in("device_id", ids)
        .order("last_seen", { ascending: false });
      for (const row of (rp ?? []) as Array<{ device_id: string; name: string | null }>) {
        if (!nameByDevice.has(row.device_id)) nameByDevice.set(row.device_id, row.name ?? null);
      }
    } catch { /* noop */ }

    // 2) Email + user_id des de account_links.
    const linkByDevice = new Map<string, { userId: string | null; email: string | null }>();
    try {
      const { data: links } = await (supabase as any)
        .from("account_links")
        .select("device_id, user_id, email, updated_at")
        .in("device_id", ids)
        .order("updated_at", { ascending: false });
      for (const row of (links ?? []) as Array<{ device_id: string; user_id: string | null; email: string | null }>) {
        if (!linkByDevice.has(row.device_id)) {
          linkByDevice.set(row.device_id, { userId: row.user_id ?? null, email: row.email ?? null });
        }
      }
    } catch { /* noop */ }

    // 3) display_name + username des de profiles (si tenim user_id).
    const userIds = Array.from(
      new Set(Array.from(linkByDevice.values()).map((v) => v.userId).filter((u): u is string => !!u)),
    );
    const profileByUser = new Map<string, { name: string | null; email: string | null; username: string | null }>();
    if (userIds.length > 0) {
      try {
        const { data: profs } = await (supabase as any)
          .from("profiles")
          .select("user_id, display_name, email, username")
          .in("user_id", userIds);
        for (const p of (profs ?? []) as Array<{ user_id: string; display_name: string | null; email: string | null; username: string | null }>) {
          profileByUser.set(p.user_id, { name: p.display_name ?? null, email: p.email ?? null, username: p.username ?? null });
        }
      } catch { /* noop */ }
    }

    for (const id of ids) {
      const link = linkByDevice.get(id);
      const prof = link?.userId ? profileByUser.get(link.userId) : undefined;
      out.set(id, {
        name: prof?.name ?? nameByDevice.get(id) ?? null,
        email: link?.email ?? prof?.email ?? null,
        username: prof?.username ?? null,
      });
    }
  } catch {
    /* noop */
  }
  return out;
}

async function resolveRoomNames(roomIds: Array<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(roomIds.filter((r): r is string => !!r)));
  if (ids.length === 0) return out;
  try {
    const { data } = await (supabase as any)
      .from("rooms")
      .select("id, code")
      .in("id", ids);
    for (const r of (data ?? []) as Array<{ id: string; code: string | null }>) {
      if (r.code) out.set(r.id, r.code);
    }
  } catch { /* noop */ }
  return out;
}

function normalize(
  row: any,
  info: Map<string, { name: string | null; email: string | null; username: string | null }>,
  rooms: Map<string, string>,
): InboxFlag {
  const dev = row.target_device_id as string | null;
  const u = dev ? info.get(dev) : undefined;
  const storedCode = typeof row.room_code === "string" && row.room_code.length > 0 ? row.room_code : null;
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: storedCode ?? (row.room_id ? (rooms.get(row.room_id) ?? null) : null),
    targetDeviceId: dev,
    reporterDeviceId: row.reporter_device_id,
    reason: row.reason ?? null,
    messageId: row.message_id ?? null,
    messageText: row.message_text ?? null,
    status: row.status as FlagStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
    source: sourceFor(row.reporter_device_id),
    weight: weightFor(row.reason),
    targetName: u?.name ?? null,
    targetUsername: u?.username ?? null,
    targetEmail: u?.email ?? null,
  };
}

export async function listInboxFlags(status: FlagStatus | "all"): Promise<InboxFlag[]> {
  let q = (supabase as any)
    .from("room_chat_flags")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  const [info, rooms] = await Promise.all([
    resolveDeviceInfo(rows.map((r) => r.target_device_id)),
    resolveRoomNames(rows.map((r) => r.room_id)),
  ]);
  return rows.map((r) => normalize(r, info, rooms));
}

export async function listAuditEntries(): Promise<AuditEntry[]> {
  const { data, error } = await (supabase as any)
    .from("room_chat_flags_audit")
    .select("*")
    .order("decided_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  const [info, rooms] = await Promise.all([
    resolveDeviceInfo(rows.map((r) => r.target_device_id)),
    resolveRoomNames(rows.map((r) => r.room_id)),
  ]);
  return rows.map((row: any) => {
    const dev = row.target_device_id as string | null;
    const u = dev ? info.get(dev) : undefined;
    const storedCode = typeof row.room_code === "string" && row.room_code.length > 0 ? row.room_code : null;
    return {
      id: row.id,
      flagId: row.flag_id,
      roomId: row.room_id ?? null,
      roomName: storedCode ?? (row.room_id ? (rooms.get(row.room_id) ?? null) : null),
      targetDeviceId: dev,
      reporterDeviceId: row.reporter_device_id ?? null,
      messageText: row.message_text ?? null,
      reason: row.reason ?? null,
      decision: row.decision,
      decidedBy: row.decided_by ?? null,
      moderatorTag: row.moderator_tag ?? null,
      moderatorNote: row.moderator_note ?? null,
      decidedAt: row.decided_at,
      targetName: u?.name ?? null,
      targetUsername: u?.username ?? null,
      targetEmail: u?.email ?? null,
    } as AuditEntry;
  });
}

export async function deleteAuditEntries(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await (supabase as any)
    .from("room_chat_flags_audit")
    .delete()
    .in("id", ids)
    .select("id");
  if (error) throw new Error(error.message);
  const deleted = (data ?? []) as Array<{ id: number }>;
  if (deleted.length === 0) {
    throw new Error("No s'ha pogut esborrar cap registre (RLS o permisos). Cal una política DELETE per a moderadors a room_chat_flags_audit.");
  }
}

export async function deleteAllAuditEntries(): Promise<void> {
  const { data: rows, error: selErr } = await (supabase as any)
    .from("room_chat_flags_audit")
    .select("id");
  if (selErr) throw new Error(selErr.message);
  const ids = ((rows ?? []) as Array<{ id: number }>).map((r) => r.id);
  if (ids.length === 0) return;
  const { data, error } = await (supabase as any)
    .from("room_chat_flags_audit")
    .delete()
    .in("id", ids)
    .select("id");
  if (error) throw new Error(error.message);
  const deleted = (data ?? []) as Array<{ id: number }>;
  if (deleted.length === 0) {
    throw new Error("No s'ha pogut esborrar cap registre (RLS o permisos). Cal una política DELETE per a moderadors a room_chat_flags_audit.");
  }
}

export interface DecideOptions {
  flag: InboxFlag;
  decision: FlagDecision;
  userId: string;
  moderatorTag: string;
  note?: string;
}

/**
 * Aplica una decisió a un flag:
 *   - approved  → manté el silenciament (Aprovar baneig).
 *   - dismissed → archiva com fals positiu.
 *   - forgiven  → només admin; equival a dismissed però registra "forgiven".
 *   - pending   → reobre.
 * Sempre escriu una entrada a room_chat_flags_audit.
 */
export async function decideFlag(opts: DecideOptions): Promise<{ auditError: string | null }> {
  const { flag, decision, userId, moderatorTag, note } = opts;

  const newStatus: FlagStatus = decision === "approved" ? "approved"
    : decision === "pending" ? "pending"
    : "dismissed";

  const { error: updateError } = await (supabase as any)
    .from("room_chat_flags")
    .update({
      status: newStatus,
      decided_at: decision === "pending" ? null : new Date().toISOString(),
      decided_by: decision === "pending" ? null : userId,
    })
    .eq("id", flag.id);

  if (updateError) throw new Error(updateError.message);

  const { error: auditError } = await (supabase as any)
    .from("room_chat_flags_audit")
    .insert({
      flag_id: flag.id,
      room_id: flag.roomId,
      room_code: flag.roomName,
      target_device_id: flag.targetDeviceId,
      reporter_device_id: flag.reporterDeviceId,
      message_id: flag.messageId,
      message_text: flag.messageText,
      reason: flag.reason,
      decision,
      decided_by: userId,
      moderator_tag: moderatorTag,
      moderator_note: note ?? null,
      flag_created_at: flag.createdAt,
      flag_expires_at: flag.expiresAt,
    });

  return { auditError: auditError ? auditError.message : null };
}

/**
 * Retorna el rol més elevat de l'usuari autenticat ('admin', 'moderator' o 'user').
 * Es pot cridar des del client perquè RLS només permet veure les pròpies files.
 */
export async function getMyRole(): Promise<AppRole> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return "user";
  const { data, error } = await (supabase as any)
    .from("user_roles")
    .select("role")
    .eq("user_id", session.user.id);
  if (error) {
    console.error("[getMyRole] Error en query a user_roles:", error);
    throw error;
  }
  const roles = ((data ?? []) as Array<{ role: AppRole }>).map((r) => r.role);
  if (roles.includes("admin")) return "admin";
  if (roles.includes("moderator")) return "moderator";
  return "user";
}