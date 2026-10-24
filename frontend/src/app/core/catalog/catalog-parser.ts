/**
 * Extractores de catálogos de previews (PDF) → lista de números solicitados.
 *
 * Reciben las líneas de texto de cada página (ver pdf-lines.ts) y devuelven
 * títulos, números, fecha de salida (exacta o solo el mes) y precio. Cada
 * editorial maqueta su catálogo de forma distinta, así que hay un extractor
 * por formato. El resultado se revisa en la app antes de guardarse.
 *
 * Código puro (sin Angular) para poder probarlo con Node contra los PDFs reales.
 */

export type CatalogPublisher = 'DC Comics' | 'Marvel Comics' | 'Image Comics';
export type IssueType = 'Regular Issue' | 'Annual' | 'Trade Paperback' | 'Hardcover';

export interface CatalogItem {
  publisher: CatalogPublisher;
  /** Título tal cual aparece en el catálogo, p. ej. "ODIN #7 (OF 9)". */
  title: string;
  /** Nombre de la serie en formato normal, p. ej. "Odin". */
  seriesName: string;
  /** Número ("7", "1005"); vacío en recopilatorios. */
  issueNumber: string;
  issueType: IssueType;
  /** Fecha exacta YYYY-MM-DD si el catálogo la trae; si no, null. */
  releaseDate: string | null;
  /** Primer día del mes de salida, YYYY-MM-01. */
  releaseMonth: string;
  price: number | null;
}

export interface CatalogParseResult {
  publisher: CatalogPublisher;
  /** Mes que solicita el catálogo (YYYY-MM-01). */
  catalogMonth: string;
  items: CatalogItem[];
}

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// ── Utilidades ──────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const firstOfMonth = (iso: string) => iso.slice(0, 8) + '01';

/** Línea "de título": tiene letras y todas en mayúscula. */
function isUpperLine(l: string): boolean {
  return /[A-Z]/.test(l) && l === l.toUpperCase() && !/[a-z]/.test(l);
}

/** Clave para comparar títulos ignorando espacios, comillas y puntuación. */
export function normTitle(s: string): string {
  return s.toUpperCase().replace(/[‘’']/g, '').replace(/[^A-Z0-9#]/g, '');
}

const SMALL_WORDS = new Set(['OF', 'THE', 'AND', 'A', 'AN', 'IN', 'ON', 'AT', 'TO', 'FOR', 'BY', 'OR', 'VS.', 'VS']);
const ACRONYMS = new Set(['JLA', 'JSA', 'DCU', 'USA', 'UK', 'TV', 'OGN', 'TP', 'TPB', 'HC', 'SFX', 'POV', 'MCU']);

/** "AMAZING SPIDER-MAN" → "Amazing Spider-Man"; respeta romanos, siglas y "DC". */
export function titleCase(s: string): string {
  const words = s.trim().replace(/\s+/g, ' ').split(' ');
  return words.map((word, i) => {
    const bare = word.replace(/[^A-Z0-9.]/g, '');
    if (ACRONYMS.has(bare)) return word;
    if (/^[IVX]+$/.test(bare) && bare.length > 1) return word;           // II, III, IV…
    if (/^([A-Z]\.)+[A-Z]?\.?$/.test(bare)) return word;                // G.I., M.A.S.K.
    if (/^[B-DF-HJ-NP-TV-XZ]{2,4}$/.test(bare)) return word;            // DC, TV (sin vocales)
    const afterColon = i > 0 && /[:–-]$/.test(words[i - 1]);
    if (i > 0 && !afterColon && SMALL_WORDS.has(word)) return word.toLowerCase();
    return word.toLowerCase().replace(/(^|[-/("“])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  }).join(' ');
}

/** Corrige años con errata (p. ej. "01/06/26" en un catálogo de 2027). */
function fixYear(y: number, m: number, catalogMonth: string): number {
  const [cy, cm] = catalogMonth.split('-').map(Number);
  const diff = (y - cy) * 12 + (m - cm);
  if (diff < -6) return y + 1;
  if (diff > 18) return y - 1;
  return y;
}

function parseSlashDate(m: number, d: number, yy: number, catalogMonth: string): string {
  const y0 = yy < 100 ? 2000 + yy : yy;
  return ymd(fixYear(y0, m, catalogMonth), m, d);
}

/**
 * Separa serie y número de un título del catálogo.
 * "ODIN #7 (OF 9)" → Odin / 7 · "AMAZING SPIDER-MAN #10 FACSIMILE EDITION" →
 * Amazing Spider-Man Facsimile Edition / 10 · "FINAL BOSS, VOL. 2 TP" → recopilatorio.
 */
export function splitTitle(raw: string): { seriesName: string; issueNumber: string; issueType: IssueType } {
  const title = raw.replace(/\s+/g, ' ').trim();
  const cleanSuffix = (s: string) => s
    .replace(/\((OF \d+|ONE-SHOT|LGY #\d+)\)/g, '')
    .replace(/\s+/g, ' ').trim();

  const m = title.match(/^(.*?)\s*#\s*(\d+(?:\.\d+)?[A-Z]?)\b(.*)$/);
  if (m) {
    const suffix = cleanSuffix(m[3]);
    const series = (m[1] + (suffix ? ' ' + suffix : '')).replace(/[\s,:–-]+$/, '');
    return {
      seriesName: titleCase(series),
      issueNumber: m[2],
      issueType: /\bANNUAL\b/.test(series) ? 'Annual' : 'Regular Issue',
    };
  }

  // Recopilatorio (sin número)
  const isHc = /\b(HC|HARDCOVER|OMNIBUS)\b/.test(title);
  return {
    seriesName: titleCase(cleanSuffix(title)),
    issueNumber: '',
    issueType: isHc ? 'Hardcover' : 'Trade Paperback',
  };
}

function makeItem(publisher: CatalogPublisher, title: string, date: string | null,
                  month: string, price: number | null, forcedType?: IssueType): CatalogItem {
  const t = title.replace(/\s+/g, ' ').trim();
  const s = splitTitle(t);
  return {
    publisher, title: t,
    seriesName: s.seriesName,
    issueNumber: s.issueNumber,
    issueType: forcedType && s.issueNumber === '' ? forcedType : s.issueType,
    releaseDate: date,
    releaseMonth: date ? firstOfMonth(date) : month,
    price,
  };
}

/** Clave de un número: serie normalizada + número (ignora "(OF 5)", etc.). */
export function itemKey(it: { seriesName: string; issueNumber: string }): string {
  return normTitle(it.seriesName) + '#' + it.issueNumber;
}

/** Elimina duplicados (mismo número): se queda con el que tenga más datos. */
function dedupe(items: CatalogItem[]): CatalogItem[] {
  const byKey = new Map<string, CatalogItem>();
  for (const it of items) {
    const k = itemKey(it);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, it); continue; }
    byKey.set(k, {
      ...prev,
      releaseDate: prev.releaseDate ?? it.releaseDate,
      releaseMonth: prev.releaseDate ? prev.releaseMonth : it.releaseMonth,
      price: prev.price ?? it.price,
    });
  }
  return [...byKey.values()];
}

function findCatalogMonth(pages: string[][], re: RegExp): string | null {
  for (const page of pages.slice(0, 6)) {
    for (const l of page) {
      const m = l.toUpperCase().match(re);
      if (m) return ymd(Number(m[2]), MONTHS.indexOf(m[1]) + 1, 1);
    }
  }
  return null;
}

// ── Detección ───────────────────────────────────────────────────────────────

export function detectPublisher(pages: string[][]): CatalogPublisher | null {
  const head = pages.slice(0, 4).flat().join('\n').toUpperCase();
  const all = pages.flat().join('\n');
  if (/DC CONNECT/.test(head)) return 'DC Comics';
  if (/IMAGE COMICS/.test(head) && /WHAT'S NEXT/.test(head)) return 'Image Comics';
  if (/PGS\.\/.*Rated/i.test(all) && /MARVEL/i.test(all)) return 'Marvel Comics';
  return null;
}

export function parseCatalog(pages: string[][]): CatalogParseResult {
  const publisher = detectPublisher(pages);
  if (publisher === 'DC Comics') return parseDC(pages);
  if (publisher === 'Marvel Comics') return parseMarvel(pages);
  if (publisher === 'Image Comics') return parseImage(pages);
  throw new Error('No se reconoce el catálogo. De momento se admiten DC Connect, Marvel (PRH) e Image.');
}

// ── DC Connect ──────────────────────────────────────────────────────────────

const DC_NOISE = /^(.*NOT FINAL TRADE DRESS.*|SPOTLIGHT.*|COMIC BOOKS|COLLECTED EDITIONS|DC CONNECT.*|\d+\+?|.*VARIANTS?)$/;
/** Eslogan encima del título: lleva "…", comillas, "!"/"?" o acaba en punto (salvo "VOL."). */
const DC_TAGLINE = /[…“”"!?]|(?<!\bVOL|\bNO)\.$/;
const DC_CREDITS = /^(Written|Story|Script|Plot|Words|Art|Adapted|Text|Created|Cover|Edited)\b.*\bby\b/i;
const DC_ON_SALE = /^ON SALE (\d{1,2})\/(\d{1,2})\/(\d{2,4})/;

function isDcTitleLine(l: string): boolean {
  return isUpperLine(l) && !DC_NOISE.test(l) && !/[!?]$/.test(l) && l.length <= 70;
}

/**
 * DC: el checklist del final ("Available Wednesday, January 6, 2027" + títulos)
 * es la lista oficial y completa → fuente principal de títulos, números y fechas.
 * Las fichas solo aportan precio y si es Hardcover/Softcover. Sin checklist,
 * se usan las fichas tal cual.
 */
function parseDC(pages: string[][]): CatalogParseResult {
  const catalogMonth = findCatalogMonth(pages, /ON SALE IN ([A-Z]+) (\d{4})/) ?? firstOfMonth(new Date().toISOString());
  const fromBlocks = parseDCBlocks(pages, catalogMonth);
  const fromChecklist = parseDCChecklist(pages, catalogMonth);
  if (fromChecklist.length === 0) return { publisher: 'DC Comics', catalogMonth, items: fromBlocks };

  // Cruce tolerante checklist ↔ fichas: ignora "THE" y, si una serie solo tiene
  // una ficha, la usa aunque el número no cuadre (el catálogo trae erratas, p. ej.
  // "Detective Comics #1116" en el checklist y "#1117" en la ficha).
  const loose = (s: string) => normTitle(s.replace(/\bTHE\b/gi, ''));
  const byKey = new Map(fromBlocks.map(b => [itemKey(b), b]));
  const byLooseKey = new Map(fromBlocks.map(b => [loose(b.seriesName) + '#' + b.issueNumber, b]));
  const bySeries = new Map<string, CatalogItem[]>();
  for (const b of fromBlocks) {
    const k = loose(b.seriesName);
    bySeries.set(k, [...(bySeries.get(k) ?? []), b]);
  }
  const items = fromChecklist.map(c => {
    const sameSeries = bySeries.get(loose(c.seriesName))?.filter(b => (b.issueNumber !== '') === (c.issueNumber !== ''));
    const b = byKey.get(itemKey(c))
      ?? byLooseKey.get(loose(c.seriesName) + '#' + c.issueNumber)
      ?? (sameSeries?.length === 1
        ? sameSeries[0] : undefined);
    if (!b) return c;
    const issueType = c.issueNumber ? c.issueType : b.issueType;  // HC/TPB según la ficha
    return { ...c, price: b.price, issueType };
  });
  return { publisher: 'DC Comics', catalogMonth, items: dedupe(items) };
}

const DC_AVAILABLE = /^Available \w+day,\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i;

function parseDCChecklist(pages: string[][], catalogMonth: string): CatalogItem[] {
  const page = pages.find(p => p.some(l => /^CHECKLIST$/.test(l)) && p.some(l => DC_AVAILABLE.test(l)));
  if (!page) return [];
  const items: CatalogItem[] = [];
  let date: string | null = null;
  let collected = false;
  for (const raw of page) {
    if (/^PERIODICALS:/i.test(raw)) { collected = false; continue; }
    if (/^COLLECTED EDITION/i.test(raw)) { collected = true; continue; }
    const a = raw.match(DC_AVAILABLE);
    if (a) {
      const m = MONTHS.indexOf(a[1].toUpperCase()) + 1;
      date = m > 0 ? ymd(Number(a[3]), m, Number(a[2])) : null;
      continue;
    }
    if (!date) continue;
    // "Absolute Wonder Woman #28 3v" → quita el nº de variantes
    const title = raw.replace(/\s+\d+v$/, '').replace(';', ':').trim();
    if (!title || !/[a-z]/i.test(title)) continue;
    if (!collected && !/#\d/.test(title)) continue;
    const upper = title.toUpperCase();
    const type: IssueType | undefined = collected
      ? (/\b(OMNIBUS|DELUXE|ABSOLUTE|COMPENDIUM|HARDCOVER)\b/.test(upper) ? 'Hardcover' : 'Trade Paperback')
      : undefined;
    items.push(makeItem('DC Comics', upper, date, catalogMonth, null, type));
  }
  return items;
}

function parseDCBlocks(pages: string[][], catalogMonth: string): CatalogItem[] {
  const items: CatalogItem[] = [];

  for (const lines of pages) {
    const anchors = lines.map((l, i) => (DC_ON_SALE.test(l) ? i : -1)).filter(i => i >= 0);
    anchors.forEach((a, k) => {
      const from = k === 0 ? 0 : anchors[k - 1] + 1;
      const to = k + 1 < anchors.length ? anchors[k + 1] : lines.length;
      const block = lines.slice(from, a + 1);

      // Título: líneas en mayúscula justo encima de los créditos ("Written by…").
      // Puede ocupar 2-3 líneas (a veces el número va solo: "ABSOLUTE WONDER
      // WOMAN" + "#28"); se para al llegar al eslogan que suele ir encima.
      let title = '';
      const c = block.findIndex(l => DC_CREDITS.test(l));
      if (c > 0) {
        const parts: string[] = [];
        for (let i = c - 1; i >= 0 && parts.length < 4; i--) {
          const numberOnly = /^#\d+\S*$/.test(block[i]);
          if (!numberOnly && (!isDcTitleLine(block[i]) || DC_TAGLINE.test(block[i]))) break;
          parts.unshift(block[i]);
        }
        title = parts.join(' ');
      }
      // Destacados: el título aparece después de la sinopsis. No vale el título
      // de la ficha siguiente (ese va seguido de sus propios créditos).
      if (!title) {
        title = lines.slice(a + 1, to).find((l, j, rest) =>
          isDcTitleLine(l) && /#\d/.test(l)
          && !rest.slice(j + 1, j + 4).some(x => DC_CREDITS.test(x))) ?? '';
      }
      if (!title) return;

      const d = lines[a].match(DC_ON_SALE)!;
      const date = parseSlashDate(Number(d[1]), Number(d[2]), Number(d[3]), catalogMonth);
      const priceLine = block.find(l => /\$\d+\.\d{2} US/.test(l)) ?? '';
      const price = priceLine.match(/\$(\d+\.\d{2})/);
      const forced: IssueType | undefined = /\|\s*Hardcover/i.test(priceLine) ? 'Hardcover'
        : /\|\s*Softcover/i.test(priceLine) ? 'Trade Paperback' : undefined;
      // En DC los recopilatorios siempre indican Hardcover/Softcover. Si no, es un
      // número suelto sin "#" en el título (especiales, one-shots) → nº 1.
      if (!forced && !/#\d/.test(title)) title += ' #1';

      items.push(makeItem('DC Comics', title, date, catalogMonth, price ? Number(price[1]) : null, forced));
    });
  }
  return dedupe(items);
}

// ── Marvel (PRH) ────────────────────────────────────────────────────────────

const MARVEL_TITLE = /^[A-Z0-9‘’'"(][A-Z0-9 ‘’'":&|.,\-–—!?/()]*#\d+[A-Z0-9 ‘’'():\-–—.#]*$/;
/** Ficha real: tras el título vienen los autores, "NOMBRE (W)" / "NOMBRE (A)". */
const MARVEL_CREDITS = /\((W|A|W\/A)\)/;
const MARVEL_FOC = /FOC [\d/]+,\s*ON-SALE (\d{1,2})\/(\d{1,2})\/(\d{2,4})/;
const MARVEL_PRICE = /…\s*\$(\d+\.\d{2})/;

function isMarvelTitle(l: string): boolean {
  return MARVEL_TITLE.test(l) && l.length <= 75 && !/^COVER\b/.test(l) && !/ BY /.test(l)
    && !/\((W|A|CA)\)$/.test(l) && !/^VARIANT/.test(l)
    && !/\bPOSTER\b/.test(l)                       // pósters
    && !/\(\d{4}\)|#\d+-\d+|\.$/.test(l);          // "DAREDEVIL (1998) #82-88." = referencias
}

function parseMarvel(pages: string[][]): CatalogParseResult {
  // 1) Checklist con fechas exactas: "FOC 12/07/26, ON-SALE 01/13/27" + títulos debajo
  const raw: { title: string; m: number; d: number; y: number }[] = [];
  for (const lines of pages) {
    if (!lines.some(l => /CHECKLIST/.test(l))) continue;
    let cur: { m: number; d: number; y: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const f = lines[i].match(MARVEL_FOC);
      if (f) { cur = { m: Number(f[1]), d: Number(f[2]), y: Number(f[3]) }; continue; }
      if (!cur) continue;
      let l = lines[i];
      // Título partido en dos líneas: "STAR WARS: AHSOKA - ESCAPE FROM" + "THRAWN #1"
      if (isUpperLine(l) && !l.includes('#') && i + 1 < lines.length && /#\d/.test(lines[i + 1])) {
        l = l + ' ' + lines[++i];
      }
      if (isMarvelTitle(l)) raw.push({ title: l, ...cur });
      else if (/^ATTENTION/.test(l)) cur = null;
    }
  }

  // Mes del catálogo: el más frecuente en el checklist
  const freq = new Map<string, number>();
  for (const r of raw) {
    const k = ymd(r.y < 100 ? 2000 + r.y : r.y, r.m, 1);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const catalogMonth = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? firstOfMonth(new Date().toISOString());

  const dated = new Map<string, string>();
  const items: CatalogItem[] = [];
  for (const r of raw) {
    const date = parseSlashDate(r.m, r.d, r.y, catalogMonth);
    dated.set(itemKey(splitTitle(r.title)), date);
    items.push(makeItem('Marvel Comics', r.title, date, catalogMonth, null));
  }

  // 2) Cuerpo del catálogo: fichas (título + autores) con su precio
  for (const lines of pages) {
    if (lines.some(l => /CHECKLIST/.test(l))) continue;
    // Número solo en su línea, con la serie en la anterior: "THE AMAZING VENOM" + "#5 (OF 5)"
    const numberOnly = (i: number) => /^#\d+/.test(lines[i])
      && isUpperLine(lines[i - 1] ?? '') && !(lines[i - 1] ?? '').includes('#');
    const titleIdx = lines
      .map((l, i) => ((isMarvelTitle(l) || numberOnly(i))
        && lines.slice(i + 1, i + 4).some(x => MARVEL_CREDITS.test(x)) ? i : -1))
      .filter(i => i >= 0);

    titleIdx.forEach((i, k) => {
      let title = numberOnly(i) ? `${lines[i - 1]} ${lines[i]}` : lines[i];
      const prev = numberOnly(i) ? '' : (lines[i - 1] ?? '');
      const next = lines[i + 1] ?? '';
      // Título partido en dos líneas: si uniéndolo con la anterior o la siguiente
      // coincide con un título del checklist ("SPECTACULAR" + "SPIDER-MAN #8",
      // "… #10" + "FACSIMILE EDITION"), nos quedamos con la unión.
      const joined = [`${prev} ${title}`, `${title} ${next}`, `${prev} ${title} ${next}`]
        .find(t => dated.has(itemKey(splitTitle(t))));
      if (!dated.has(itemKey(splitTitle(title))) && joined) {
        title = joined;
      } else if (isUpperLine(prev) && !prev.includes('#') && /[:|–-]$/.test(prev)) {
        title = prev + ' ' + title;          // "STAR WARS | MARVEL:" + "HOPE ASSEMBLES #1"
      }

      // Precio: la línea "…$4.99" más cercana sin cruzar a otra ficha
      const lo = k > 0 ? titleIdx[k - 1] + 1 : 0;
      const hi = k + 1 < titleIdx.length ? titleIdx[k + 1] : lines.length;
      let price: number | null = null;
      let bestDist = Infinity;
      for (let j = lo; j < hi; j++) {
        const pm = lines[j].match(MARVEL_PRICE);
        if (pm && Math.abs(j - i) < bestDist) { bestDist = Math.abs(j - i); price = Number(pm[1]); }
      }

      const date = dated.get(itemKey(splitTitle(title))) ?? null;
      items.push(makeItem('Marvel Comics', title, date, catalogMonth, price));
    });
  }

  // 3) Checklist de recopilatorios: "VENOM VOL. 2: COMING TO TERMS TPB (ON SALE 02/24/27)"
  for (const lines of pages) {
    if (!lines.some(l => /^COLLECTIONS$/.test(l))) continue;
    let buf = '';
    for (const l of lines) {
      if (/^(FOC|COLLECTIONS|CHECKLIST)\b/.test(l)) { buf = ''; continue; }
      buf = (buf + ' ' + l).trim();
      const m = buf.match(/^(.*?)\s*\(ON SALE\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\)/);
      if (m) {
        const title = m[1].replace(/\s*\[.*?\]\s*/g, ' ').replace(/\((MARVEL [A-Z ]+)\)/g, '').trim();
        const date = parseSlashDate(Number(m[2]), Number(m[3]), Number(m[4]), catalogMonth);
        items.push(makeItem('Marvel Comics', title, date, catalogMonth, null));
        buf = '';
      } else if (/\(ON SALE$/.test(buf) === false && buf.length > 160) {
        buf = '';
      }
    }
  }

  return { publisher: 'Marvel Comics', catalogMonth, items: dedupe(items) };
}

// ── Image ───────────────────────────────────────────────────────────────────

const IMAGE_SPEC = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\b.*?\$(\d+\.\d{2})/;
const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parseImage(pages: string[][]): CatalogParseResult {
  const catalogMonth = findCatalogMonth(pages, /WHAT'S NEXT \| ([A-Z]+) (\d{4})/) ?? firstOfMonth(new Date().toISOString());
  const [cy] = catalogMonth.split('-').map(Number);

  // 1) Checklist: "52 ODIN #7 (OF 9)"; los títulos largos continúan en la línea siguiente
  const checklistPage = pages.find(p => p.some(l => /YOUR MUST-HAVE CHECKLIST/.test(l))) ?? [];
  const entries: string[] = [];
  let started = false;
  for (const l of checklistPage) {
    const m = l.match(/^(\d{1,3})\s+(.+)$/);
    if (m && isUpperLine(m[2])) { entries.push(m[2]); started = true; }
    else if (started && isUpperLine(l) && entries.length && !/RATINGS$/.test(l)) {
      entries[entries.length - 1] += ' ' + l;
    }
  }
  const titles = entries
    .map(t => t.replace(/\s+/g, ' ').trim())
    .filter(t => !/\b(PREVIEW|COVERS)$/.test(t) && !/BACKLIST/.test(t))
    .filter(t => /#\d|\b(TP|HC)\b/.test(t));

  // 2) Fecha y precio desde la ficha: "JAN 27 32 PAGES FC T+ $3.99"
  const items: CatalogItem[] = titles.map(title => {
    const key = normTitle(title);
    let date: string | null = null;
    let price: number | null = null;
    for (const lines of pages) {
      if (lines === checklistPage) continue;
      const ti = lines.findIndex((l, i) => normTitle(l) === key
        || normTitle(l + ' ' + (lines[i + 1] ?? '')) === key);
      if (ti < 0) continue;
      // La línea de especificaciones más cercana al título en esa página
      let best: { dist: number; m: RegExpMatchArray } | null = null;
      lines.forEach((l, i) => {
        const m = l.match(IMAGE_SPEC);
        if (m && (!best || Math.abs(i - ti) < best.dist)) best = { dist: Math.abs(i - ti), m };
      });
      if (best) {
        const m = (best as { m: RegExpMatchArray }).m;
        const mon = SHORT_MONTHS.indexOf(m[1]) + 1;
        date = ymd(fixYear(cy, mon, catalogMonth), mon, Number(m[2]));
        price = Number(m[3]);
        break;
      }
    }
    return makeItem('Image Comics', title, date, catalogMonth, price);
  });

  return { publisher: 'Image Comics', catalogMonth, items: dedupe(items) };
}
