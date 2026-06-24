import { Routes } from '@angular/router';
import { authGuard } from './core/auth-guard';
import { Login } from './pages/login/login';
import { Calendar } from './pages/calendar/calendar';
import { NewReleases } from './pages/new-releases/new-releases';
import { AddToList } from './pages/add-to-list/add-to-list';
import { Settings } from './pages/settings/settings';

export const routes: Routes = [
  { path: 'login', component: Login },
  { path: '', redirectTo: 'dc', pathMatch: 'full' },
  { path: 'dc',     component: Calendar,     canActivate: [authGuard] },
  { path: 'marvel', component: Calendar,     canActivate: [authGuard] },
  { path: 'otros',  component: Calendar,     canActivate: [authGuard] },
  { path: 'new-releases', component: NewReleases, canActivate: [authGuard] },
  { path: 'add',    component: AddToList,    canActivate: [authGuard] },
  { path: 'settings', component: Settings,   canActivate: [authGuard] },
  { path: '**', redirectTo: 'dc' },
];
