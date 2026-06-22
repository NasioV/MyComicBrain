import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { SupabaseService } from '../../core/supabase';
import { PullFormat, ReleaseRow } from '../../core/types';

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

  pulledIds = signal<Set<number>>(new Set());
  addingId = signal<number | null>(null);
  addingFormat = signal<PullFormat>('digital');
  addingError = signal('');

  monthLabel = computed(() =>
    new Date(this.year(), this.month() - 1, 1)
      .toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
  );

  filtered = computed(() => {
    const pub = this.selectedPublisher();
    const q = this.searchQuery().toLowerCase().trim();
    let list = this.allReleases();
    if (pub) list = list.filter(r => r.series.publishers.name === pub);
    if (q)   list = list.filter(r => r.series.name.toLowerCase().includes(q));
    return list;
  });

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
