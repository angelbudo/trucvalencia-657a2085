# Privacidad real de cartas en partida online

## Diagnóstico

Hoy el `match_state` (con las 12 cartas de las 4 manos) vive en la columna JSONB `rooms.match_state`. Los 4 clientes se suscriben a esa fila vía `postgres_changes` (`src/online/useRoomRealtime.ts:357`), así que **reciben las manos completas por la red** aunque luego `maskMatchStateForSeat` las oculte visualmente. Es una fuga real: cualquiera con DevTools ve las 3 cartas de los rivales.

`maskMatchStateForSeat` existe sólo en cliente; el servidor (`supabase/functions/rooms-rpc`) nunca enmascara. Las RLS de `rooms` permiten leer la fila entera a los miembros de la sala.

## Objetivo

El servidor debe enviar a cada cliente **sólo su mano**; las manos de los rivales viajan como `null`/`facedown`. Las cartas jugadas en mesa siguen visibles para todos (ya están en `round.tricks` / mesa, no en `hands`).

## Plan

### 1. Backend (`supabase/functions/rooms-rpc`)

- **Nuevo helper `maskStateForSeat(state, seat)`** en `_game/`: clona `state`, sustituye `state.round.hands[p]` por un array de `null` (o `{ hidden: true }` × longitud real) para todo `p !== seat`. No toca `tricks`, `mesa`, `envit`, log público, etc.
- **No** cambiamos la columna `match_state` (sigue siendo la fuente de verdad para el servidor y los bots). Cambiamos cómo se entrega a los clientes:
  - **Quitar la suscripción `postgres_changes` a `rooms`** en cliente (paso 3) y reemplazarla por **broadcast realtime por sala** con payload ya enmascarado.
  - Tras cada `submitAction` / `advanceBots` / `startMatch` / cualquier mutación de `match_state`, el handler hace `channel.send({ type: 'broadcast', event: 'state', payload: { forSeat: p, state: maskStateForSeat(state, p), version, ... } })` para cada uno de los 4 asientos (4 broadcasts pequeños) o uno solo `event: 'state'` con `{ perSeat: { 0:…, 1:…, 2:…, 3:… }, spectator: maskStateForSeat(state, null) }` y el cliente coge su trozo.
  - Espectadores reciben la versión `seat=null` (todas las manos ocultas).
- **`getRoom` RPC**: ya devuelve el DTO inicial; enmascarar `matchState` antes de responder según `deviceId → seat`.

### 2. RLS de `rooms.match_state`

- Crear vista o policy que **omita `match_state`** en `SELECT` directo para los jugadores (la lectura pasa a hacerse vía RPC + broadcast). Alternativa mínima: dejar RLS como está pero los clientes ya no harán `select('*')` de `rooms` para el estado, sólo para metadatos de sala.
- Mantener acceso completo con `service_role` (edge function).

### 3. Frontend (`src/online/useRoomRealtime.ts`)

- Eliminar la suscripción `postgres_changes` a `rooms.match_state` (mantener la de `room_players`, chat, etc.).
- Suscribirse al canal broadcast `room:{code}:state` y aplicar `payload.state` directamente — ya viene enmascarado por servidor.
- Borrar `maskMatchStateForSeat` del cliente (o dejarlo como defensa en profundidad para el optimistic update local).
- Optimistic updates (`applyOptimistic`): seguir enmascarando localmente para el propio asiento (ya tiene su mano completa); para los rivales no hay nada que enmascarar porque ya no se conoce.

### 4. Verificación

- Test manual con 2 pestañas (host + invitado): en DevTools → Network/WS, inspeccionar payload del broadcast y confirmar que `hands[otroAsiento]` viene como `[null,null,null]`.
- Jugar una carta y verificar que aparece boca arriba en `mesa`/`tricks` para todos.
- Bots siguen funcionando (corren en servidor con estado completo).

## Detalles técnicos

- `MatchState.round.hands: Record<PlayerId, Card[]>` → tras enmascarar: `Record<PlayerId, (Card | null)[]>`. Hay que ajustar el tipo a `Array<Card | null>` o introducir `HiddenCard = null`. Tocar `src/game/types.ts` y todos los consumidores que asumen `Card` (principalmente `TrucBoard`, `PlayerSeat`, `useTrucMatch` solo para render — la lógica de motor corre en servidor o en modo offline con estado completo).
- En modo offline (vs bots) **nada cambia**: `useTrucMatch` sigue trabajando con el estado completo local.
- Coste: ~4× tamaño de payload por mutación (un broadcast por asiento) pero cada uno es pequeño; aceptable.

## Riesgos

- Cambio invasivo en la capa realtime online; hay que probar reconexiones, espectadores y rematch.
- Si algún componente lee `round.hands[otroAsiento][i].suit` sin guard `!= null`, romperá. Hay que auditar `TrucBoard` y `PlayerSeat`.

¿Procedo con esta implementación?