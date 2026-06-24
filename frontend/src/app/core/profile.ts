export const AVATARS = [
  'avatar-1', 'avatar-2', 'avatar-3', 'avatar-4',
  'avatar-5', 'avatar-6', 'avatar-7', 'avatar-8',
] as const;

export const VIEW_KEY = 'mcb-calendar-view';

export interface Profile {
  username: string;
  avatarId: string | null;
  email: string;
}

export function avatarUrl(avatarId: string | null): string | null {
  return avatarId ? `/avatars/${avatarId}.png` : null;
}

export function initials(username: string): string {
  const parts = username.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
