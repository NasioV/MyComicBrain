import { Component, OnInit, HostListener, inject, signal, computed } from '@angular/core';
import { SupabaseService } from '../../core/supabase';
import { PullFormat, ReleaseRow } from '../../core/types';

const PAGE = 48;

export const ALL_ISSUE_TYPES = [
  'Regular Issue',
  'Annual',
  'Trade Paperback',
  'Hardcover',
  'Variant & Reprint',
] as const;

const DEFAULT_ACTIVE_TYPES = new Set<string>(['Regular Issue', 'Annual', 'Variant & Reprint']);

@Component({
  selector: 'app-new-releases',
  imports: [],
  templateUrl: './new-releases.html',
  styleUrl: './new-releases.scss',
})
export class NewReleases implements OnInit {
  private supabase = inject(SupabaseService);

  year = signal(new Date().getFullYear());
  month = signal(new Date().getMonth() + 1);

  allReleases = signal<ReleaseRow[]>([]);
  publishers = signal<string[]>([]);
  selectedPublisher = signal('');
  searchQuery = signal('');
  loading = signal(true);

  activeTypes = signal<Set<string>>(new Set(DEFAULT_ACTIVE_TYPES));
  readonly allIssueTypes = ALL_ISSUE_TYPES;

  pulledIds = signal<Set<number>>(new Set());
  addingId = signal<number | null>(null);
  addingFormat = signal<PullFormat>('digital');
  addingError = signal('');

  monthLabel = computed(() =>
    new Date(this.year(), this.month() - 1, 1)
      .toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
  );

  visibleCount = signal(PAGE);

  filtered = computed(() => {
    const pub = this.selectedPublisher();
    const q = this.searchQuery().toLowerCase().trim();
    const types = this.activeTypes();
    let list = this.allReleases();
    if (pub)   list = list.filter(r => r.series.publishers.name === pub);
    if (q)     list = list.filter(r => r.series.name.toLowerCase().includes(q));
    list = list.filter(r => types.has(r.issue_type ?? 'Regular Issue'));
    return list;
  });

  // Solo se renderiza una tanda; crece al hacer scroll (fluidez con cientos de items)
  visible = computed(() => this.filtered().slice(0, this.visibleCount()));

  @HostListener('window:scroll')
  onScroll() {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 800;
    if (nearBottom && this.visibleCount() < this.filtered().length) {
      this.visibleCount.update(n => n + PAGE);
    }
  }

  private resetVisible() {
    this.visibleCount.set(PAGE);
    window.scrollTo({ top: 0 });
  }

  onSearch(value: string) {
    this.searchQuery.set(value);
    this.resetVisible();
  }

  onPublisher(value: string) {
    this.selectedPublisher.set(value);
    this.resetVisible();
  }

  async ngOnInit() {
    await Promise.all([this.loadReleases(), this.loadPulledIds()]);
  }

  async loadReleases() {
    this.loading.set(true);
    const { data, error } = await this.supabase.getReleasesForMonth(this.year(), this.month());
    if (!error && data) {
      const rows = (data as unknown as ReleaseRow[]).sort((a, b) =>
        a.series.name.localeCompare(b.series.name) || a.issue_number.localeCompare(b.issue_number)
      );
      this.allReleases.set(rows);
      const pubs = [...new Set(rows.map(r => r.series.publishers.name))].sort();
      this.publishers.set(pubs);
    }
    this.resetVisible();
    this.loading.set(false);
  }

  async loadPulledIds() {
    this.pulledIds.set(await this.supabase.getUserPullIssueIds());
  }

  prevMonth() {
    if (this.month() === 1) { this.year.update(y => y - 1); this.month.set(12); }
    else { this.month.update(m => m - 1); }
    this.loadReleases();
  }

  nextMonth() {
    if (this.month() === 12) { this.year.update(y => y + 1); this.month.set(1); }
    else { this.month.update(m => m + 1); }
    this.loadReleases();
  }

  toggleType(type: string) {
    const next = new Set(this.activeTypes());
    if (next.has(type)) { next.delete(type); } else { next.add(type); }
    this.activeTypes.set(next);
    this.resetVisible();
  }

  isAdded(issueId: number): boolean {
    return this.pulledIds().has(issueId);
  }

  startAdd(issueId: number) {
    this.addingId.set(issueId);
    this.addingFormat.set('digital');
    this.addingError.set('');
  }

  cancelAdd() {
    this.addingId.set(null);
  }

  async confirmAdd(release: ReleaseRow) {
    const { error } = await this.supabase.addToPullList(release, this.addingFormat());
    if (error) {
      this.addingError.set('Error al añadir.');
      return;
    }
    this.pulledIds.update(ids => new Set([...ids, release.issue_id]));
    this.addingId.set(null);
  }

  setFormat(f: PullFormat) {
    this.addingFormat.set(f);
  }

  formatDate(iso: string): string {
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
  }
}
