import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMyRole } from "@/online/moderationInbox";
import { useAuth } from "./useAuth";

export type AppRole = "user" | "moderator" | "admin";

export function useMyRole() {
  const { user, ready: authReady } = useAuth();
  const queryClient = useQueryClient();

  const cacheKey = user ? `truc_user_role_${user.id}` : null;
  const cachedRole =
    cacheKey && typeof window !== "undefined"
      ? (localStorage.getItem(cacheKey) as AppRole | null)
      : null;

  const { data: role, isLoading, refetch } = useQuery<AppRole>({
    queryKey: ["myRole", user?.id],
    queryFn: async () => {
      if (!user) {
        console.log("[useMyRole] Sin usuario autenticado. Forzando rol 'user'.");
        return "user";
      }
      try {
        console.log(
          `[useMyRole] Consultando rol real en Supabase para el usuario: ${user.email} (${user.id})...`,
        );
        const fetchedRole = await getMyRole();
        console.log(`[useMyRole] ¡Rol obtenido con éxito de Supabase!: "${fetchedRole}"`);
        if (cacheKey) localStorage.setItem(cacheKey, fetchedRole);
        return fetchedRole;
      } catch (error) {
        console.error("[useMyRole] Error al obtener rol de Supabase, usando caché si existe:", error);
        return (cachedRole as AppRole) || "user";
      }
    },
    enabled: authReady && !!user,
    initialData: (cachedRole as AppRole) || undefined,
    staleTime: 1000 * 60 * 1,
  });

  const isAdmin = role === "admin";
  const isModerator = isAdmin || role === "moderator";

  return {
    role: (role as AppRole) || "user",
    isAdmin,
    isModerator,
    ready: authReady && (!isLoading || role !== undefined),
    forceRefresh: async () => {
      if (cacheKey) localStorage.removeItem(cacheKey);
      await queryClient.invalidateQueries({ queryKey: ["myRole", user?.id] });
      await refetch();
    },
  };
}