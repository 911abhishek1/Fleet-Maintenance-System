import './style.css';
import { registerRoute, initRouter } from './router';
import { isLoggedIn } from './state';
import { renderLayout, updateActiveNav } from './components/layout';
import { renderLoginPage } from './pages/login';
import { renderDashboardPage } from './pages/dashboard';
import { renderVehiclesPage } from './pages/vehicles';
import { renderServicesPage } from './pages/services';

// Track whether layout is rendered
let layoutRendered = false;

function ensureLayout(): void {
  const appEl = document.getElementById('app')!;
  if (!layoutRendered) {
    renderLayout(appEl);
    layoutRendered = true;
  }
  updateActiveNav();
}

// --- Register Routes ---

registerRoute({
  path: '/login',
  render: (_container) => {
    // Login gets the full app container, not the page-content
    layoutRendered = false;
    const appEl = document.getElementById('app')!;
    appEl.innerHTML = '';
    renderLoginPage(appEl);
  },
});

registerRoute({
  path: '/dashboard',
  guard: () => isLoggedIn(),
  render: async (_container) => {
    ensureLayout();
    const pageContent = document.getElementById('page-content')!;
    await renderDashboardPage(pageContent);
  },
});

registerRoute({
  path: '/vehicles',
  guard: () => isLoggedIn(),
  render: async (_container) => {
    ensureLayout();
    const pageContent = document.getElementById('page-content')!;
    await renderVehiclesPage(pageContent);
  },
});

registerRoute({
  path: '/services',
  guard: () => isLoggedIn(),
  render: async (_container) => {
    ensureLayout();
    const pageContent = document.getElementById('page-content')!;
    await renderServicesPage(pageContent);
  },
});

// --- Initialize ---
initRouter();
