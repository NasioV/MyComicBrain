import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SupabaseService } from '../../core/supabase';
import { AVATARS, VIEW_KEY, avatarUrl } from '../../core/profile';

@Component({
  selector: 'app-settings',
  imports: [RouterLink],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  private supabase = inject(SupabaseService);

  readonly avatars = AVATARS;
  username = signal('');
  selectedAvatar = signal<string | null>(null);
  viewMode = signal<'table' | 'visual'>('visual');
  email = signal('');
  saving = signal(false);
  success = signal(false);
  error = signal('');

  async ngOnInit() {
    const p = await this.supabase.getProfile();
    if (p) {
      this.username.set(p.username);
      this.selectedAvatar.set(p.avatarId);
      this.email.set(p.email);
    }
    this.viewMode.set(localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'visual');
  }

  avatarSrc(id: string) { return avatarUrl(id); }

  selectAvatar(id: string) {
    this.selectedAvatar.set(this.selectedAvatar() === id ? null : id);
    this.success.set(false);
  }

  setView(mode: 'table' | 'visual') {
    this.viewMode.set(mode);
    this.success.set(false);
  }

  async save() {
    const name = this.username().trim();
    if (!name) { this.error.set('El nombre no puede estar vacío.'); return; }
    this.saving.set(true);
    this.error.set('');
    const { error } = await this.supabase.updateProfile({
      username: name,
      avatar_id: this.selectedAvatar() ?? '',
    });
    localStorage.setItem(VIEW_KEY, this.viewMode());
    this.saving.set(false);
    if (error) { this.error.set('No se pudo guardar.'); return; }
    this.success.set(true);
  }
}
