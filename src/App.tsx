import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WelcomeGate } from "@/components/WelcomeGate";
import { GlobalInviteListener } from "@/online/GlobalInviteListener";
import { GlobalLobbyWarmup } from "@/online/GlobalLobbyWarmup";
import { AccountLinkSync } from "@/components/AccountLinkSync";
import { AdminNoticeDialog } from "@/components/AdminNoticeDialog";
import { OnlineBanGate } from "@/components/OnlineBanGate";

import Index from "./pages/Index";
import Ajustes from "./pages/Ajustes";
import Partida from "./pages/Partida";
import NotFound from "./pages/NotFound";
import OnlineLobby from "./pages/online/Lobby";
import OnlineSales from "./pages/online/Sales";
import OnlineNou from "./pages/online/Nou";
import OnlineUnir from "./pages/online/Unir";
import OnlineSala from "./pages/online/Sala";
import OnlinePartida from "./pages/online/PartidaOnline";
import PoliticaPrivacitat from "./pages/PoliticaPrivacitat";
import TermesCondicions from "./pages/TermesCondicions";
import AvisLegal from "./pages/AvisLegal";
import PoliticaCookies from "./pages/PoliticaCookies";
import Reportar from "./pages/Reportar";
import EsborrarDades from "./pages/EsborrarDades";

import Moderacio from "./pages/admin/Moderacio";
import Regles from "./pages/Regles";
import { loadBlacklistFromSupabase } from "@/online/profanityFilter";

// Carrega la blacklist el més aviat possible (idempotent).
// Si Supabase falla o tarda, el filtre ja funciona amb la llista per defecte.
if (typeof window !== "undefined") {
  void loadBlacklistFromSupabase();
}
import Auth from "./pages/Auth";
import Perfil from "./pages/Perfil";
import PerfilPublic from "./pages/PerfilPublic";
import Classificacions from "./pages/Classificacions";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <Sonner />
    <BrowserRouter>
      <ErrorBoundary>
        <WelcomeGate>
          <GlobalInviteListener />
          <GlobalLobbyWarmup />
          <AccountLinkSync />
          <AdminNoticeDialog />
          <OnlineBanGate>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/ajustes" element={<Ajustes />} />
              <Route path="/partida" element={<Partida />} />
              <Route path="/online/sales" element={<OnlineSales />} />
              <Route path="/online/lobby/:sala" element={<OnlineLobby />} />
              <Route path="/online/nou" element={<OnlineNou />} />
              <Route path="/online/unir" element={<OnlineUnir />} />
              <Route path="/online/sala/:codi" element={<OnlineSala />} />
              <Route path="/online/partida/:codi" element={<OnlinePartida />} />
              <Route path="/privacitat" element={<PoliticaPrivacitat />} />
              <Route path="/termes" element={<TermesCondicions />} />
              <Route path="/avis-legal" element={<AvisLegal />} />
              <Route path="/cookies" element={<PoliticaCookies />} />
              <Route path="/reportar" element={<Reportar />} />
              <Route path="/esborrar-dades" element={<EsborrarDades />} />
              <Route path="/eliminar-cuenta" element={<EsborrarDades />} />
              <Route path="/regles" element={<Regles />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/perfil" element={<Perfil />} />
              <Route path="/perfil/:userId" element={<PerfilPublic />} />
              <Route path="/classificacions" element={<Classificacions />} />
              <Route path="/admin/moderacio" element={<Moderacio />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </OnlineBanGate>
        </WelcomeGate>
      </ErrorBoundary>
    </BrowserRouter>
  </QueryClientProvider>
);

export default App;