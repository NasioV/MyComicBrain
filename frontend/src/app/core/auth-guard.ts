import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseService } from './supabase';

export const authGuard: CanActivateFn = async () => {
  // inject() debe llamarse de forma síncrona, antes de cualquier await:
  // tras el await ya no hay contexto de inyección (NG0203).
  const supabase = inject(SupabaseService);
  const router = inject(Router);
  const { data } = await supabase.getSession();
  if (data.session) return true;
  return router.createUrlTree(['/login']);
};
