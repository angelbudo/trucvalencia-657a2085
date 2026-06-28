/**
 * Capes visuals del tauler de Truc.
 * Mantén el xat de mesa sempre per sota de seients, cartells i bombolles.
 */
export const TRUC_Z_INDEX = {
  tableChat: 5,
  board: 10,
  handArea: 20,
  seat: 30,
  tableActions: 40,
  shout: 60,
  chatBubble: 80,
  // Els calaixos de Preguntes / Respostes / Altres han de tapar sempre els
  // noms i avatars dels jugadors, inclosos els seients amb capes locals altes.
  chatDrawer: 100,
  chatControls: 110,
  // Pantalles flotants crítiques (abandonar / pausa / començar nova partida):
  // han d'aparèixer per damunt de tota la resta de la pantalla de partida.
  endGameOverlay: 9000,
  pauseOverlay: 9000,
  confirmDialog: 9100,
} as const;