import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { SupabaseService } from '../../core/supabase';
import { PreviewRow, PullFormat } from '../../core/types';
import { CatalogItem, CatalogParseResult, parseCatalog } from '../../core/catalog/catalog-parser';
import { readPdfLines } from '../../core/catalog/pdf-reader';
import { UNCONFIRMED_KEY, UNCONFIRMED_LABEL, mondayOf, weekLabel } from '../../core/weeks';

const ISSUE_TYPES = ['Regular Issue', 'Annual', 'Trade Paperback', 'Hardcover'] as const;

interface ReviewItem extends CatalogItem { selected: boolean; }
interface WeekGroup { key: string; label: string; items: PreviewRow[]; }

@Component({
  selector: 'app-pull-list',
  imports: [],
  templateUrl: './pull-list.html',
  styleUrl: './pull-list.scss',
})
export class PullList implements OnInit {
  private supabase = inject(SupabaseService);

  // ── Vista por mes ────────────────────────────────────────────────────────
  months = signal<string[]>([]);
  month = signal<string | null>(null);          // 'YYYY-MM-01'
  previews = signal<PreviewRow[]>([]);
  inList = signal<Map<string, PullFormat>>(new Map());
  loading = signal(true);
  publisher = signal('');
  search = signal('');
  activeTypes = signal<Set<string>>(new Set(['Regular Issue', 'Annual']));
  readonly issueTypes = ISSUE_TYPES;
  busyId = signal<string | null>(null);
  message = signal('');

  monthLabel = computed(() => {
    const m = this.month();
    if (!m) return '';
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  });
  monthIndex = computed(() => this.months().indexOf(this.month() ?? ''));

  publishers = computed(() => [...new Set(this.previews().map(p => p.publishers.name))].sort());

  filtered = computed(() => {
    const pub = this.publisher();
    const q = this.search().toLowerCase().trim();
    const types = this.activeTypes();
    return this.previews().filter(p =>
      (!pub || p.publishers.name === pub)
      && (!q || p.series_name.toLowerCase().includes(q))
      && types.has(p.issue_type));
  });

  weeks = computed<WeekGroup[]>(() => {
    const groups = new Map<string, PreviewRow[]>();
    for (const p of this.filtered()) {
      const k = p.release_date ? mondayOf(p.release_date) : UNCONFIRMED_KEY;
      let arr = groups.get(k);
      if (!arr) { arr = []; groups.set(k, arr); }
      arr.push(p);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, items]) => ({
        key,
        label: key === UNCONFIRMED_KEY ? UNCONFIRMED_LABEL : weekLabel(key),
        items: items.sort((a, b) => a.series_name.localeCompare(b.series_name)
          || a.issue_number.localeCompare(b.issue_number, undefined, { numeric: true })),
      }));
  });

  /** Totales del mes de lo que ya está en mi lista (todas las editoriales y tipos). */
  totals = computed(() => {
    const inList = this.inList();
    let fisico = 0, digital = 0, count = 0, noPrice = 0;
    for (const p of this.previews()) {
      const fmt = inList.get(p.id);
      if (!fmt) continue;
      count++;
      if (p.price === null) { noPrice++; continue; }
      if (fmt === 'fisico') fisico += Number(p.price); else digital += Number(p.price);
    }
    return { fisico, digital, total: fisico + digital, count, noPrice };
  });

  async ngOnInit() {
    await this.loadMonths();
  }

  private async loadMonths(prefer?: string) {
    const months = await this.supabase.getPreviewMonths();
    this.months.set(months);
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const pick = (prefer && months.includes(prefer) && prefer)
      || months.find(m => m >= current)
      || months[months.length - 1]
      || null;
    this.month.set(pick);
    await this.loadMonth();
  }

  async loadMonth() {
    const m = this.month();
    this.loading.set(true);
    if (!m) { this.previews.set([]); this.loading.set(false); return; }
    const [y, mo] = m.split('-').map(Number);
    const [previews, inList] = await Promise.all([
      this.supabase.getPreviewsForMonth(y, mo),
      this.supabase.getPreviewPulls(),
    ]);
    this.previews.set(previews);
    this.inList.set(inList);
    this.loading.set(false);
  }

  prevMonth() { this.goTo(this.monthIndex() - 1); }
  nextMonth() { this.goTo(this.monthIndex() + 1); }
  private goTo(i: number) {
    const m = this.months()[i];
    if (!m) return;
    this.month.set(m);
    this.loadMonth();
  }

  toggleType(t: string) {
    const next = new Set(this.activeTypes());
    if (next.has(t)) next.delete(t); else next.add(t);
    this.activeTypes.set(next);
  }

  async add(p: PreviewRow, format: PullFormat) {
    this.busyId.set(p.id);
    this.message.set('');
    const { error } = await this.supabase.addPreviewToPull(p, format);
    this.busyId.set(null);
    if (error) { this.message.set(`${p.series_name} #${p.issue_number}: ${error}`); return; }
    this.inList.update(m => new Map(m).set(p.id, format));
  }

  dateLabel(p: { release_date: string | null }): string {
    if (!p.release_date) return 'Por confirmar';
    const [, m, d] = p.release_date.split('-');
    return `${d}/${m}`;
  }

  money(n: number | null): string {
    return n === null ? '—' : `$${Number(n).toFixed(2)}`;
  }

  // ── Importar catálogo ────────────────────────────────────────────────────
  importOpen = signal(false);
  importing = signal(false);
  progress = signal('');
  importError = signal('');
  parsed = signal<CatalogParseResult | null>(null);
  review = signal<ReviewItem[]>([]);
  saving = signal(false);
  private fileName = '';

  selectedCount = computed(() => this.review().filter(i => i.selected).length);

  openImport() {
    this.importOpen.set(true);
    this.parsed.set(null);
    this.review.set([]);
    this.importError.set('');
    this.progress.set('');
  }

  closeImport() {
    if (this.importing() || this.saving()) return;
    this.importOpen.set(false);
  }

  async onFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    this.fileName = file.name;
    this.importError.set('');
    this.parsed.set(null);
    this.importing.set(true);
    try {
      const pages = await readPdfLines(file, (i, n) => this.progress.set(`Leyendo página ${i} de ${n}…`));
      const result = parseCatalog(pages);
      if (result.items.length === 0) throw new Error('No se ha encontrado ningún cómic en el PDF.');
      this.parsed.set(result);
      this.review.set(result.items.map(i => ({ ...i, selected: true })));
    } catch (e) {
      this.importError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.importing.set(false);
      this.progress.set('');
      input.value = '';
    }
  }

  toggleItem(i: number) {
    this.review.update(list => list.map((it, k) => (k === i ? { ...it, selected: !it.selected } : it)));
  }

  setAll(selected: boolean) {
    this.review.update(list => list.map(it => ({ ...it, selected })));
  }

  editItem(i: number, field: 'seriesName' | 'issueNumber' | 'price' | 'releaseDate', value: string) {
    this.review.update(list => list.map((it, k) => {
      if (k !== i) return it;
      switch (field) {
        case 'price': return { ...it, price: value === '' ? null : Number(value) };
        case 'releaseDate': return {
          ...it,
          releaseDate: value || null,
          releaseMonth: value ? value.slice(0, 8) + '01' : it.releaseMonth,
        };
        default: return { ...it, [field]: value.trim() };
      }
    }));
  }

  async saveImport() {
    const items: CatalogItem[] = this.review()
      .filter(i => i.selected && i.seriesName)
      .map(({ selected, ...item }) => item);
    if (items.length === 0) return;
    this.saving.set(true);
    const { saved, error } = await this.supabase.savePreviews(items, this.fileName);
    this.saving.set(false);
    if (error) { this.importError.set(`Error al guardar (${saved} guardados): ${error}`); return; }
    const month = this.parsed()?.catalogMonth;
    this.importOpen.set(false);
    this.message.set(`Importados ${saved} cómics de ${this.parsed()?.publisher}.`);
    await this.loadMonths(month);
  }
}
