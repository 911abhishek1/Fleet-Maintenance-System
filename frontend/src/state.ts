export interface User {
  id: string;
  email: string;
  role: 'FLEET_MANAGER' | 'TECHNICIAN';
}

export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function getUser(): User | null {
  const raw = localStorage.getItem('user');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function isLoggedIn(): boolean {
  return !!getToken() && !!getUser();
}

export function isFleetManager(): boolean {
  return getUser()?.role === 'FLEET_MANAGER';
}

export function isTechnician(): boolean {
  return getUser()?.role === 'TECHNICIAN';
}

export function setAuth(token: string, user: User): void {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

export function clearAuth(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

export function getUserInitials(): string {
  const user = getUser();
  if (!user) return '?';
  return user.email.charAt(0).toUpperCase();
}

export function formatRole(role: string): string {
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
