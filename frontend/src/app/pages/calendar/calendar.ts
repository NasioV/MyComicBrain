import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SupabaseService } from '../../core/supabase';
import { PublisherGroup, PullFormat, PullRow, PullStatus } from '../../core/types';
import { VIEW_KEY } from '../../core/profile';

interface WeekGroup { key: string; label: string; pulls: PullRow[]; }

/** Lunes (ISO) de la semana que contiene la fecha, como 'YYYY-MM-DD'. */
function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7; // lunes = 0
  dt.setDate(dt.getDate() - dow);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function weekLabel(mondayIso: string): string {
  const [y, m, d] = mondayIso.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const mon = (dt: Date) => dt.toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');
  if (start.getMonth() === end.getMonth()) {
    return `Semana ${start.getDate()}–${end.getDate()} ${mon(start)}`;
  }
  return `Semana ${start.getDate()} ${mon(start)} – ${end.getDate()} ${mon(end)}`;
}

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
    (localStorage.getItem(VIEW_KEY) as 'table' | 'visual') ?? 'visual'
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

  prevPending = signal(0);
  nextPending = signal(0);

  monthLabel = computed(() => {
    const d = new Date(this.year(), this.month() - 1, 1);
    return d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  });

  // Agrupación por semanas: dentro de cada semana, pendientes primero (alfabético)
  // y los leídos al final.
  weeks = computed<WeekGroup[]>(() => {
    const groups = new Map<string, PullRow[]>();
    for (const p of this.pulls()) {
      const k = mondayOf(p.release_date);
      let arr = groups.get(k);
      if (!arr) { arr = []; groups.set(k, arr); }
      arr.push(p);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, arr]) => {
        arr.sort((a, b) => {
          const al = a.status === 'leido' ? 1 : 0;
          const bl = b.status === 'leido' ? 1 : 0;
          if (al !== bl) return al - bl;                       // leídos al final
          return a.series.name.localeCompare(b.series.name);   // alfabético
        });
        return { key, label: weekLabel(key), pulls: arr };
      });
  });

  // Resumen del mes: contadores por estado (solo los que tienen alguno)
  summary = computed(() => {
    const counts: Record<PullStatus, number> = { no_salido: 0, descargar: 0, listo: 0, pedido: 0, leido: 0 };
    for (const p of this.pulls()) counts[p.status]++;
    const order: PullStatus[] = ['descargar', 'listo', 'pedido', 'no_salido', 'leido'];
    return order
      .filter(s => counts[s] > 0)
      .map(s => ({ status: s, label: this.STATUS_LABELS[s], count: counts[s], cls: 'chip-' + s.replace('_', '-') }));
  });

  async ngOnInit() {
    const path = this.route.snapshot.url[0]?.path ?? 'dc';
    const groupMap: Record<string, PublisherGroup> = { dc: 'DC', marvel: 'MARVEL', otros: 'OTROS' };
    this.group.set(groupMap[path] ?? 'DC');

    // Automatismo v1: aplica el ascenso digital -> descargar (global) antes de
    // mostrar nada, así el calendario ya refleja el estado correcto.
    await this.supabase.autoUpgradeDigitalReleases();

    // Arrancar en el primer mes con cosas pendientes (no leídas) del grupo.
    const start = await this.supabase.getFirstPendingMonth(this.group());
    if (start) { this.year.set(start.year); this.month.set(start.month); }

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
    this.loadAdjacent();
  }

  private adjacent(delta: number): { year: number; month: number } {
    let m = this.month() + delta;
    let y = this.year();
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    return { year: y, month: m };
  }

  async loadAdjacent() {
    const prev = this.adjacent(-1);
    const next = this.adjacent(1);
    const [p, n] = await Promise.all([
      this.supabase.getPendingCount(this.group(), prev.year, prev.month),
      this.supabase.getPendingCount(this.group(), next.year, next.month),
    ]);
    this.prevPending.set(p);
    this.nextPending.set(n);
  }

  async changeStatus(pull: PullRow, newStatus: PullStatus) {
    pull.status = newStatus;
    this.pulls.update(list => [...list]);
    await this.supabase.updatePullStatus(pull.id, newStatus);
  }

  async changeFormat(pull: PullRow) {
    const next: PullFormat = pull.format === 'digital' ? 'fisico' : 'digital';
    pull.format = next;
    this.pulls.update(list => [...list]);
    await this.supabase.updatePullFormat(pull.id, next);
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
