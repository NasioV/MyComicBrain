import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SupabaseService } from '../../core/supabase';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private supabase = inject(SupabaseService);
  private router = inject(Router);

  email = '';
  password = '';
  loading = signal(false);
  error = signal('');

  async submit() {
    this.loading.set(true);
    this.error.set('');
    const { error } = await this.supabase.signInWithPassword(this.email, this.password);
    this.loading.set(false);
    if (error) {
      this.error.set('Email o contraseña incorrectos.');
    } else {
      this.router.navigate(['/']);
    }
  }
}
