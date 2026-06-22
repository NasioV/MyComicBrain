import { Injectable } from '@angular/core';
import { createClient, SupabaseClient, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import { PublisherGroup, PublisherOption, PullFormat, PullStatus, ReleaseRow, SeriesResult, SyncLog } from './types';

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

  updatePullStatus(pullId: string, status: PullStatus) {
    return this.client
      .from('pulls')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', pullId);
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
      .select('issue_id, series_id, issue_number, release_date, cover_url, price, series!inner(name, publishers!inner(name, publisher_group))')
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
