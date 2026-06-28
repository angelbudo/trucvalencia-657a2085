import { supabase } from "@/integrations/supabase/client";

/**
 * Aplica una penalització d'XP al jugador autenticat per haver abandonat
 * una partida sense acabar-la. La penalització NO pot deixar l'XP per
 * sota de 0 ni el nivell per sota de 1.
 *
 * La lògica real (calcular nou XP i nou nivell respectant els mínims)
 * viu al backend (RPC `apply_xp_penalty`). Si la RPC encara no està
 * desplegada al servidor o l'usuari no està autenticat, la crida falla
 * silenciosament — no volem bloquejar la navegació d'abandonar.
 */
export async function applyAbandonXpPenalty(amount = 10): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // RPC encara no tipada a `supabase/types.ts`; fem cast per evitar errors
    // de typecheck fins que es regeneren els tipus després de la migració.
    await (supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>)("apply_xp_penalty", { p_amount: amount });
  } catch (e) {
    console.warn("[applyAbandonXpPenalty]", e);
  }
}