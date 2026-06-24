import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { SupabaseService } from '../../core/supabase';
import { Profile, avatarUrl, initials } from '../../core/profile';

@Component({
  selector: 'app-nav',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './nav.html',
  styleUrl: './nav.scss',
})
export class Nav implements OnInit {
  private supabase = inject(SupabaseService);
  private router = inject(Router);

  profile = signal<Profile | null>(null);
  menuOpen = signal(false);

  username = computed(() => this.profile()?.username ?? 'Usuario');
  avatar = computed(() => avatarUrl(this.profile()?.avatarId ?? null));
  initials = computed(() => initials(this.username()));

  ngOnInit() {
    this.refresh();
    // Refresca cuando el usuario actualiza su perfil (USER_UPDATED) o cambia sesión.
    // Usamos la session del callback directamente: llamar a getSession()/getProfile()
    // aquí dentro provoca un deadlock del lock de auth de Supabase.
    this.supabase.onAuthStateChange((_event, session) => {
      this.profile.set(this.supabase.profileFromSession(session));
    });
  }

  private async refresh() {
    this.profile.set(await this.supabase.getProfile());
  }

  toggleMenu() { this.menuOpen.update(v => !v); }
  closeMenu() { this.menuOpen.set(false); }

  async signOut() {
    this.closeMenu();
    await this.supabase.signOut();
    this.router.navigate(['/login']);
  }
}
