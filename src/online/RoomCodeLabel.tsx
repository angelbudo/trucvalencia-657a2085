/**
 * Etiqueta "Taula X49B". La paraula "Taula" només es mostra
 * a partir de l'amplada md; el codi mai s'encongeix.
 */
export function RoomCodeLabel({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  return (
    <span className={"shrink-0 whitespace-nowrap " + (className ?? "")}>
      <span className="hidden md:inline">Taula </span>
      {code}
    </span>
  );
}