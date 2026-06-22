import { Component, OnInit, inject, signal } from '@angular/core';
import { SupabaseService } from '../../core/supabase';
import { PullFormat, PublisherOption, SeriesResult } from '../../core/types';

type Mode = 'search' | 'create';

@Component({
  selector: 'app-add-to-list',
  imports: [],
  templateUrl: './add-to-list.html',
  styleUrl: './add-to-list.scss',
})
export class AddToList implements OnInit {
  private supabase = inject(SupabaseService);

  // ── Series selection ───────────────────────────────────────────
  mode = signal<Mode>('search');
  searchQuery = signal('');
  searchResults = signal<SeriesResult[]>([]);
  showDropdown = signal(false);
  searching = signal(false);
  selectedSeries = signal<SeriesResult | null>(null);

  // ── Create new series ──────────────────────────────────────────
  publishers = signal<PublisherOption[]>([]);
  newSeriesName = signal('');
  selectedPublisherId = signal<number | null>(null);
  creating = signal(false);
  createError = signal('');

  // ── Issue details ──────────────────────────────────────────────
  issueNumber = signal('');
  releaseDate = signal('');
  format = signal<PullFormat>('digital');

  // ── Submit ─────────────────────────────────────────────────────
  submitting = signal(false);
  submitError = signal('');
  success = signal(false);

  async ngOnInit() {
    this.publishers.set(await this.supabase.getPublishers());
  }

  async onSearchInput(value: string) {
    this.searchQuery.set(value);
    this.selectedSeries.set(null);
    this.success.set(false);
    if (value.length < 2) { this.searchResults.set([]); this.showDropdown.set(false); return; }
    this.searching.set(true);
    const results = await this.supabase.searchSeries(value);
    this.searching.set(false);
    this.searchResults.set(results);
    this.showDropdown.set(true);
  }

  selectSeries(s: SeriesResult) {
    this.selectedSeries.set(s);
    this.searchQuery.set(s.name);
    this.showDropdown.set(false);
    this.mode.set('search');
  }

  startCreate() {
    this.newSeriesName.set(this.searchQuery());
    this.mode.set('create');
    this.showDropdown.set(false);
    this.createError.set('');
  }

  cancelCreate() {
    this.mode.set('search');
    this.createError.set('');
  }

  async confirmCreate() {
    const name = this.newSeriesName().trim();
    const pubId = this.selectedPublisherId();
    if (!name || !pubId) { this.createError.set('Completa nombre y editorial.'); return; }
    const pub = this.publishers().find(p => p.publisher_id === pubId);
    if (!pub) return;
    this.creating.set(true);
    const { seriesId, error } = await this.supabase.createSeries(name, pub);
    this.creating.set(false);
    if (error || !seriesId) { this.createError.set('Error al crear la serie.'); return; }
    const created: SeriesResult = {
      series_id: seriesId,
      name,
      publishers: { name: pub.name, publisher_group: pub.publisher_group },
    };
    this.selectSeries(created);
  }

  setFormat(f: PullFormat) { this.format.set(f); }

  async submit() {
    const series = this.selectedSeries();
    const num = this.issueNumber().trim();
    const date = this.releaseDate();
    if (!series) { this.submitError.set('Selecciona o crea una serie.'); return; }
    if (!num)    { this.submitError.set('Introduce el número del número.'); return; }
    if (!date)   { this.submitError.set('Introduce la fecha de salida.'); return; }
    this.submitting.set(true);
    this.submitError.set('');
    const { error } = await this.supabase.addManualPull(series.series_id, num, date, this.format());
    this.submitting.set(false);
    if (error) { this.submitError.set('Error al guardar. ¿Ya existe este número en tu lista?'); return; }
    this.success.set(true);
    this.reset();
  }

  reset() {
    this.selectedSeries.set(null);
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.issueNumber.set('');
    this.releaseDate.set('');
    this.format.set('digital');
    this.submitError.set('');
    this.mode.set('search');
  }

  closeDropdown() {
    setTimeout(() => this.showDropdown.set(false), 150);
  }
}
