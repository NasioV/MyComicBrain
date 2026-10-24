/** Fragmento de texto tal como lo devuelve pdf.js (getTextContent().items). */
export interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  transform: number[];
}

/**
 * Reconstruye las líneas de una página a partir de los fragmentos de pdf.js.
 *
 * Se respeta el orden del propio PDF (que sigue los bloques de texto, columna a
 * columna) y se corta línea cuando pdf.js marca fin de línea o cuando la
 * posición vertical salta. Agrupar solo por altura mezclaría columnas vecinas.
 */
export function itemsToLines(items: TextItemLike[]): string[] {
  const lines: string[] = [];
  let current = '';
  let lastY: number | null = null;

  const flush = () => {
    const l = current.replace(/\s+/g, ' ').trim();
    if (l) lines.push(l);
    current = '';
  };

  for (const it of items) {
    const y = it.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 3 && current.trim()) {
      flush();
    }
    current += it.str;
    if (y !== undefined) lastY = y;
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}
