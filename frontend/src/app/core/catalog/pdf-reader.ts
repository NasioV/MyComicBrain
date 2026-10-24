import { itemsToLines, TextItemLike } from './pdf-lines';

/**
 * Lee un PDF en el propio navegador (no se sube a ningún sitio) y devuelve las
 * líneas de texto de cada página. pdf.js se carga bajo demanda, solo al importar
 * un catálogo, para no engordar la carga normal de la app.
 */
export async function readPdfLines(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<string[][]> {
  const pdfjs = await import('pdfjs-dist');
  // El worker se copia a la raíz del build (ver angular.json → assets)
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages: string[][] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(itemsToLines(content.items as unknown as TextItemLike[]));
      page.cleanup();
      onProgress?.(i, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
