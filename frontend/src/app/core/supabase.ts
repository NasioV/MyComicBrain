import { Injectable } from '@angular/core';
import { createClient, SupabaseClient, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import { PublisherGroup, PublisherOption, PullFormat, PullStatus, ReleaseRow, SeriesResult, SyncLog } from './types';
import { Profile } from './profile';

async function computeManualSeriesId(name: string, publisherName: string): Promise<number> {
  const raw = `${name}|${publisherName}`.toLowerCase();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const arr = new Uint8Array(buf);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + arr[i];
  return -n; // negative, max ~2^48, no collision with positive LoCG IDs
}

@Injectable({ providedIn: 'root' })
export class SupabaseService {
  readonly client: SupabaseClient = createClient(
    environment.supabaseUrl,
    environment.supabaseAnonKey,
  );

  getSession() {
    return this.client.auth.getSession();
  }

  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void) {
    return this.client.auth.onAuthStateChange(callback);
  }

  signInWithPassword(email: string, password: string) {
    return this.client.auth.signInWithPassword({ email, password });
  }

  signOut() {
    return this.client.auth.signOut();
  }

  /** Mapea una sesión a Profile de forma SÍNCRONA (sin tocar el cliente de auth).
   *  Seguro de usar dentro del callback de onAuthStateChange. */
  profileFromSession(session: Session | null): Profile | null {
    if (!session) return null;
    const u = session.user;
    const m = (u.user_metadata ?? {}) as Record<string, unknown>;
    return {
      username: (m['username'] as string) || (u.email?.split('@')[0] ?? 'Usuario'),
      avatarId: (m['avatar_id'] as string) ?? null,
      email: u.email ?? '',
      // por defecto ocultos (true) si nunca se ha configurado
      hideDcGo: m['hide_dc_go'] === undefined ? true : !!m['hide_dc_go'],
    };
  }

  async getProfile(): Promise<Profile | null> {
    const { data: { session } } = await this.client.auth.getSession();
    return this.profileFromSession(session);
  }

  updateProfile(data: { username?: string; avatar_id?: string; hide_dc_go?: boolean }) {
    return this.client.auth.updateUser({ data });
  }

  async getPullsForMonth(group: PublisherGroup, year: number, month: number) {
    const { data: { session } } = await this.client.auth.getSession();
    if (!session) return { data: null, error: new Error('No session') };

    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const nm = month === 12 ? 1 : month + 1;
    const ny = month === 12 ? year + 1 : year;
    const end = `${ny}-${String(nm).padStart(2, '0')}-01`;

    return this.client
      .from('pulls')
      .select('id, issue_number, release_date, cover_url, format, status, series!inner(name, publishers!inner(name, publisher_group))')
      .eq('user_id', session.user.id)
      .eq('series.publishers.publisher_group', group)
      .gte('release_date', start)
      .lt('release_date', end)
      .order('release_date', { ascending: true });
  }

  deletePull(pullId: string) {
    return this.client.from('pulls').delete().eq('id', pullId);
  }

  /** Nº de pulls pendientes (no leídos) de un grupo en un mes. Para avisar en las flechas. */
  async getPendingCount(group: PublisherGroup, year: number, month: number): Promise<number> {
    const { data: { session } } = await this.client.auth.getSession();
    if (!session) return 0;
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const nm = month === 12 ? 1 : month + 1;
    const ny = month === 12 ? year + 1 : year;
    const end = `${ny}-${String(nm).padStart(2, '0')}-01`;

    const { count } = await this.client
      .from('pulls')
      .select('id, series!inner(publishers!inner(publisher_group))', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
      .eq('series.publishers.publisher_group', group)
      .gte('release_date', start)
      .lt('release_date', end)
      .neq('status', 'leido');
    return count ?? 0;
  }

  updatePullStatus(pullId: string, status: PullStatus) {
    return this.client
      .from('pulls')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', pullId);
  }

  /**
   * Automatismo v1: los pulls digitales cuya fecha ya ha llegado pasan de
   * 'no_salido' a 'descargar'. Una sola query global (todos los grupos/meses),
   * con la fecha LOCAL del navegador (Madrid). El worker nunca toca status.
   */
  async autoUpgradeDigitalReleases() {
    const { data: { session } } = await this.client.auth.getSession();
    if (!session) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return this.client
      .from('pulls')
      .update({ status: 'descargar', updated_at: new Date().toISOString() })
      .eq('user_id', session.user.id)
      .eq('status', 'no_salido')
      .eq('format', 'digital')
      .lte('release_date', today);
  }

  async searchSeries(query: string): Promise<SeriesResult[]> {
    if (query.length < 2) return [];
    const { data } = await this.client
      .from('series')
      .select('series_id, name, publishers!inner(name, publisher_group)')
      .ilike('name', `%${query}%`)
      .limit(10);
    return (data ?? []) as unknown as SeriesResult[];
  }

  async getPublishers(): Promise<PublisherOption[]> {
    const { data } = await this.client
      .from('publishers')
      .select('publisher_id, name, publisher_group')
      .order('name');
    return (data ?? []) as PublisherOption[];
  }

  async createSeries(name: string, publisher: PublisherOption): Promise<{ seriesId: number | null; error: unknown }> {
    const seriesId = await computeManualSeriesId(name, publisher.name);
    const { error } = await this.client
      .from('series')
      .upsert({ series_id: seriesId, name, publisher_id: publisher.publisher_id, source: 'manual' }, { onConflict: 'series_id' });
    return { seriesId: error ? null : seriesId, error };
  }

  async addManualPull(seriesId: number, issueNumber: string, releaseDate: string, format: PullFormat) {
    const { data: { session } } = await this.client.auth.getSession();
    if (!session) return { error: new Error('No session') };
    const status: PullStatus = format === 'digital' ? 'no_salido' : 'pedido';
    return this.client.from('pulls').insert({
      user_id: session.user.id,
      series_id: seriesId,
      issue_id: null,
      issue_number: issueNumber,
      release_date: releaseDate,
      format,
      status,
    });
  }

  getReleasesForMonth(year: number, month: number) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const nm = month === 12 ? 1 : month + 1;
    const ny = month === 12 ? year + 1 : year;
    const end = `${ny}-${String(nm).padStart(2, '0')}-01`;

    return this.client
      .from('releases')
      .select('issue_id, series_id, issue_number, release_date, cover_url, price, issue_type, series!inner(name, publishers!inner(name, publisher_group))')
      .gte('release_date', start)
      .lt('release_date', end)
      .order('release_date', { ascending: true });
  }

  async getUserPullIssueIds(): Promise<Set<number>> {
    const { data: { session } } = await this.client.auth.getSession();
    if (!session) return new Set();
    const { data } = await this.client
      .from('pulls')
      .select('issue_id')
      .eq('user_id', session.user.id)
      .not('issue_id', 'is', null);
    return new Set((data ?? []).map((p: { issue_id: number }) => p.issue_id));
  }

  async addToPullList(release: ReleaseRow, format: PullFormat) {
    const { data: { session } } = await this.client.auth.getSession();
    if (!session) return { error: new Error('No session') };
    const status: PullStatus = format === 'digital' ? 'no_salido' : 'pedido';
    return this.client.from('pulls').insert({
      user_id: session.user.id,
      series_id: release.series_id,
      issue_id: release.issue_id,
      issue_number: release.issue_number,
      release_date: release.release_date,
      cover_url: release.cover_url,
      format,
      status,
    });
  }

  async getLastSync(): Promise<{ data: SyncLog | null; error: unknown }> {
    const { data, error } = await this.client
      .from('sync_log')
      .select('*')
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return { data: data as SyncLog | null, error };
  }
}
