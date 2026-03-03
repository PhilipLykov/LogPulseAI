import type { CurrentUser } from '../api';

/** Check if user has a specific permission. */
export function hasPermission(user: CurrentUser | null, perm: string): boolean {
  if (!user) return false;
  // Administrators get everything.
  if (user.role === 'administrator') return true;
  return user.permissions?.includes(perm) ?? false;
}
