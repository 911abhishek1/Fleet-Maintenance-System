export interface Route {
  path: string;
  render: (container: HTMLElement) => void | Promise<void>;
  guard?: () => boolean;
}

const routes: Route[] = [];
let currentCleanup: (() => void) | null = null;

export function registerRoute(route: Route): void {
  routes.push(route);
}

export function navigate(path: string): void {
  window.location.hash = `#${path}`;
}

export function getCurrentPath(): string {
  const hash = window.location.hash.slice(1) || '/dashboard';
  // Strip query string for route matching
  const qIndex = hash.indexOf('?');
  return qIndex >= 0 ? hash.slice(0, qIndex) : hash;
}

export function getQueryParams(): URLSearchParams {
  const hash = window.location.hash.slice(1) || '';
  const qIndex = hash.indexOf('?');
  return new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
}

function matchRoute(path: string): Route | undefined {
  return routes.find((r) => r.path === path);
}

export async function handleRouteChange(): Promise<void> {
  const path = getCurrentPath();
  const route = matchRoute(path);

  // Run cleanup of previous page
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  // Use page-content if it exists (layout rendered), otherwise fall back to #app
  const container = document.getElementById('page-content') || document.getElementById('app');
  if (!container) return;

  if (!route) {
    // Default redirect
    if (path === '/') {
      navigate('/dashboard');
      return;
    }
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>Page not found</h3>
        <p>The page "${path}" doesn't exist.</p>
      </div>
    `;
    return;
  }

  // Auth guard
  if (route.guard && !route.guard()) {
    navigate('/login');
    return;
  }

  container.innerHTML = '';
  await route.render(container);
}

export function setCleanup(fn: () => void): void {
  currentCleanup = fn;
}

export function initRouter(): void {
  window.addEventListener('hashchange', handleRouteChange);

  // Initial route
  if (!window.location.hash) {
    window.location.hash = '#/login';
  } else {
    handleRouteChange();
  }
}

export function getActiveRoute(): string {
  return getCurrentPath();
}
