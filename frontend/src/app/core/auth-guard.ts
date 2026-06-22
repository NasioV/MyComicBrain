import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseService } from './supabase';

export const authGuard: CanActivateFn = async () => {
  const { data } = await inject(SupabaseService).getSession();
  if (data.session) return true;
  return inject(Router).createUrlTree(['/login']);
};
