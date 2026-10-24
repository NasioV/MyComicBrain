/** Lunes (ISO) de la semana que contiene la fecha, como 'YYYY-MM-DD'. */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7; // lunes = 0
  dt.setDate(dt.getDate() - dow);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** "Semana 3–9 jun" (o "Semana 30 jun – 6 jul" si cruza de mes). */
export function weekLabel(mondayIso: string): string {
  const [y, m, d] = mondayIso.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const mon = (dt: Date) => dt.toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');
  if (start.getMonth() === end.getMonth()) {
    return `Semana ${start.getDate()}–${end.getDate()} ${mon(start)}`;
  }
  return `Semana ${start.getDate()} ${mon(start)} – ${end.getDate()} ${mon(end)}`;
}

export const UNCONFIRMED_KEY = 'zz-por-confirmar';
export const UNCONFIRMED_LABEL = 'Fecha por confirmar';
