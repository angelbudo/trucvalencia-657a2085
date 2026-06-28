// Helper centralitzat per garantir que NOMÉS hi haja una partida pendent
// en tota l'aplicació (o online, o local contra bots, mai les dues).
//
// Quan l'usuari inicia una partida nova, cal netejar la "altra" partida
// pendent (i, si correspon, qualsevol mesa online vella on encara estiga
// assegut) abans/durant l'inici de la nova. El servidor `leaveRoom`
// s'encarrega de tancar la mesa si era l'últim humà (retorna `abandoned`).

import { listMyActiveRooms, leaveRoom } from "@/online/rooms.functions";
import { clearSavedMatch } from "@/hooks/useTrucMatch";

/**
 * Llista totes les meses online on aquest dispositiu encara està assegut i
 * crida `leaveRoom` per cadascuna. Es pot excloure una mesa concreta
 * (per exemple, la que estem a punt d'unir-nos / reincorporar-nos).
 */
async function leaveAllMyActiveOnlineRooms(
  deviceId: string,
  exceptRoomCode: string | null = null,
): Promise<void> {
  if (!deviceId) return;
  try {
    const { rooms } = await listMyActiveRooms({ data: { deviceId } });
    const targets = rooms.filter((r) => r.code !== exceptRoomCode);
    if (targets.length === 0) return;
    await Promise.allSettled(
      targets.map((r) =>
        leaveRoom({ data: { roomId: r.id, deviceId } }).catch(() => undefined),
      ),
    );
  } catch {
    /* silenciós: la neteja és best-effort */
  }
}

/**
 * Garanteix que, en iniciar una partida del tipus indicat, no quede cap altra
 * partida pendent (de l'altre tipus o duplicada del mateix tipus).
 *
 * - `kind: "local"`  → s'inicia una partida contra bots. Esborra l'estat
 *   guardat localment (el sobreescriurem) i abandona TOTES les meses online
 *   on aquest dispositiu encara estiga assegut.
 * - `kind: "online"` → s'inicia/uneix a una partida online. Esborra la
 *   partida de bots guardada i abandona QUALSEVOL altra mesa online vella
 *   (excepte `keepRoomCode`, que és la mesa de destinació actual).
 */
export async function clearOtherPendingMatches(opts: {
  kind: "local" | "online";
  deviceId: string;
  keepRoomCode?: string | null;
}): Promise<void> {
  const { kind, deviceId, keepRoomCode = null } = opts;
  // Sempre netegem la partida local: ja siga perquè estem començant una de
  // nova contra bots (cal sobreescriure) o perquè començem una online (no
  // pot conviure amb una pendent de bots).
  clearSavedMatch();
  await leaveAllMyActiveOnlineRooms(deviceId, kind === "online" ? keepRoomCode : null);
}