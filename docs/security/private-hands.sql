-- Privacidad real de cartas en partida online.
-- ============================================================================
-- ⚠️  APLICAR MANUALMENTE en el SQL Editor de tu proyecto Supabase
--     (sgonrrtqdcwyajsmufhs) ANTES de desplegar la nueva versión de la edge
--     function `rooms-rpc`. Sin esta migración, el servidor fallará al intentar
--     leer/escribir en `room_private_hands`.
-- ============================================================================
--
-- Crea una tabla separada para guardar las manos completas (3 cartas reales
-- por asiento). Sólo accesible por `service_role` (la propia edge function).
-- A partir de este cambio, la columna `rooms.match_state` se almacena con las
-- manos enmascaradas (placeholders sin suit/rank), por lo que el broadcast
-- de Supabase Realtime (`postgres_changes`) ya no expone las cartas de los
-- rivales a nadie. Cada cliente sólo recibe SUS PROPIAS cartas mediante la
-- nueva RPC `getMyHand`.

CREATE TABLE IF NOT EXISTS public.room_private_hands (
  room_id uuid PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  hands jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.room_private_hands ENABLE ROW LEVEL SECURITY;

-- Sólo `service_role` (la edge function `rooms-rpc`) puede leer/escribir.
-- Sin políticas para `anon`/`authenticated`, RLS bloquea todo acceso directo
-- desde el cliente.
GRANT ALL ON public.room_private_hands TO service_role;
REVOKE ALL ON public.room_private_hands FROM anon, authenticated, PUBLIC;

-- No publicar en `supabase_realtime`: las manos privadas no se difunden vía
-- `postgres_changes`. (No-op si la publicación no incluía la tabla todavía.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime DROP TABLE public.room_private_hands;
    EXCEPTION WHEN undefined_object THEN
      NULL;
    END;
  END IF;
END $$;