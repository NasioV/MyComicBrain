import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { Nav } from './shared/nav/nav';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Nav],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private router = inject(Router);
  isLoginPage = signal(window.location.pathname === '/login');
  themeClass = signal(this.computeTheme(window.location.pathname));

  ngOnInit() {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(e => {
      const url = (e as NavigationEnd).urlAfterRedirects;
      this.isLoginPage.set(url.startsWith('/login'));
      this.themeClass.set(this.computeTheme(url));
    });
  }

  private computeTheme(url: string): string {
    if (url.startsWith('/marvel')) return 'theme-marvel';
    if (url.startsWith('/otros')) return 'theme-otros';
    if (url.startsWith('/dc')) return 'theme-dc';
    return 'theme-neutral';
  }
}
