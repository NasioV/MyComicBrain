import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SupabaseService } from '../../core/supabase';
import { PublisherGroup, PullRow, PullStatus } from '../../core/types';

@Component({
  selector: 'app-calendar',
  imports: [],
  templateUrl: './calendar.html',
  styleUrl: './calendar.scss',
})
export class Calendar implements OnInit {
  private route = inject(ActivatedRoute);
  private supabase = inject(SupabaseService);

  group = signal<PublisherGroup>('DC');
  year = signal(new Date().getFullYear());
  month = signal(new Date().getMonth() + 1);
  viewMode = signal<'table' | 'visual'>(
    (localStorage.getItem('mcb-calendar-view') as 'table' | 'visual') ?? 'table'
  );

  pulls = signal<PullRow[]>([]);
  loading = signal(true);
  syncError = signal('');
  nextUpdate = signal('');

  readonly STATUS_LABELS: Record<PullStatus, string> = {
    no_salido: 'No salido',
    descargar: 'Descargar',
    listo: 'Listo',
    pedido: 'Pedido',
    leido: 'Leído',
  };

  readonly STATUS_OPTIONS: PullStatus[] = ['no_salido', 'descargar', 'listo', 'pedido', 'leido'];

  monthLabel = computed(() => {
    const d = new Date(this.year(), this.month() - 1, 1);
    return d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  });

  async ngOnInit() {
    const path = this.route.snapshot.url[0]?.path ?? 'dc';
    const groupMap: Record<string, PublisherGroup> = { dc: 'DC', marvel: 'MARVEL', otros: 'OTROS' };
    this.group.set(groupMap[path] ?? 'DC');

    // Automatismo v1: aplica el ascenso digital -> descargar (global) antes de
    // mostrar nada, así el calendario ya refleja el estado correcto.
    await this.supabase.autoUpgradeDigitalReleases();
    await this.loadPulls();
    this.checkSync();
    this.setNextUpdate();
  }

  async loadPulls() {
    this.loading.set(true);
    const { data, error } = await this.supabase.getPullsForMonth(this.group(), this.year(), this.month());
    if (error || !data) {
      this.loading.set(false);
      this.pulls.set([]);
      return;
    }
    this.pulls.set(data as unknown as PullRow[]);
    this.loading.set(false);
  }

  async changeStatus(pull: PullRow, newStatus: PullStatus) {
    pull.status = newStatus;
    this.pulls.update(list => [...list]);
    await this.supabase.updatePullStatus(pull.id, newStatus);
  }

  confirmingRemove = signal<PullRow | null>(null);

  askRemove(pull: PullRow) {
    this.confirmingRemove.set(pull);
  }

  cancelRemove() {
    this.confirmingRemove.set(null);
  }

  async confirmRemove() {
    const pull = this.confirmingRemove();
    if (!pull) return;
    this.confirmingRemove.set(null);
    this.pulls.update(list => list.filter(p => p.id !== pull.id));
    await this.supabase.deletePull(pull.id);
  }

  prevMonth() {
    if (this.month() === 1) { this.year.update(y => y - 1); this.month.set(12); }
    else { this.month.update(m => m - 1); }
    this.loadPulls();
  }

  nextMonth() {
    if (this.month() === 12) { this.year.update(y => y + 1); this.month.set(1); }
    else { this.month.update(m => m + 1); }
    this.loadPulls();
  }

  async checkSync() {
    const { data } = await this.supabase.getLastSync();
    if (!data) {
      this.syncError.set('Sin datos de sincronización.');
      return;
    }
    const daysSince = (Date.now() - new Date(data.ran_at).getTime()) / 86_400_000;
    if (data.status === 'error') {
      this.syncError.set(`Último sync falló: ${data.message ?? 'error desconocido'}`);
    } else if (daysSince > 10) {
      this.syncError.set(`Sin actualizar desde hace ${Math.floor(daysSince)} días.`);
    }
  }

  setNextUpdate() {
    const now = new Date();
    const day = now.getUTCDay();
    let daysUntil = (1 - day + 7) % 7;
    if (daysUntil === 0 && now.getUTCHours() >= 7) daysUntil = 7;
    const next = new Date(now);
    next.setUTCDate(now.getUTCDate() + daysUntil);
    next.setUTCHours(7, 0, 0, 0);

    const label = next.toLocaleDateString('es-ES', {
      weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'Europe/Madrid',
    });
    const hour = next.toLocaleTimeString('es-ES', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
    });
    this.nextUpdate.set(`próxima actualización: ${label} a las ${hour}`);
  }

  formatDate(iso: string): string {
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
  }

  setView(mode: 'table' | 'visual') {
    this.viewMode.set(mode);
    localStorage.setItem('mcb-calendar-view', mode);
  }

  rowClass(status: PullStatus): string {
    return `row-${status.replace('_', '-')}`;
  }

  cardClass(status: PullStatus): string {
    return `card-${status.replace('_', '-')}`;
  }

  showPublisher(): boolean {
    return this.group() === 'OTROS';
  }
}
