import { getUser, getUserInitials, formatRole, clearAuth, isFleetManager } from '../state';
import { navigate, getActiveRoute } from '../router';

export function renderLayout(appEl: HTMLElement): void {
  const user = getUser();

  appEl.innerHTML = `
    <div class="app-layout">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <h1>
            <span class="brand-icon">🚛</span>
            FleetPro
          </h1>
          <div class="brand-subtitle">Fleet Management</div>
        </div>

        <nav class="sidebar-nav" id="sidebar-nav">
          <span class="nav-section-label">Main</span>
          <button class="nav-item" data-route="/dashboard">
            <span class="nav-icon">📊</span>
            Dashboard
          </button>
          ${isFleetManager() ? `
          <button class="nav-item" data-route="/vehicles">
            <span class="nav-icon">🚗</span>
            Vehicles
          </button>
          ` : ''}
          <button class="nav-item" data-route="/services">
            <span class="nav-icon">🔧</span>
            Services
          </button>

          <span class="nav-section-label" style="margin-top: auto;">Account</span>
          <button class="nav-item" id="logout-btn">
            <span class="nav-icon">🚪</span>
            Logout
          </button>
        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-user">
            <div class="user-avatar">${getUserInitials()}</div>
            <div class="user-info">
              <div class="user-email">${user?.email ?? 'Unknown'}</div>
              <div class="user-role">${formatRole(user?.role ?? '')}</div>
            </div>
          </div>
        </div>
      </aside>

      <main class="main-content">
        <header class="top-header">
          <h2 class="header-title" id="header-title">Dashboard</h2>
          <div class="header-actions">
            <span class="badge badge-role">${formatRole(user?.role ?? '')}</span>
          </div>
        </header>
        <div class="page-content" id="page-content"></div>
      </main>
    </div>
  `;

  // Sidebar navigation
  const sidebarNav = document.getElementById('sidebar-nav')!;
  sidebarNav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.nav-item[data-route]') as HTMLElement;
    if (btn) {
      const route = btn.dataset.route!;
      navigate(route);
    }
  });

  // Logout
  document.getElementById('logout-btn')!.addEventListener('click', () => {
    clearAuth();
    navigate('/login');
  });

  // Highlight active nav item
  updateActiveNav();
}

export function updateActiveNav(): void {
  const active = getActiveRoute();
  const items = document.querySelectorAll('.nav-item[data-route]');
  items.forEach((item) => {
    const route = (item as HTMLElement).dataset.route;
    item.classList.toggle('active', route === active);
  });

  // Update header title
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) {
    const titles: Record<string, string> = {
      '/dashboard': 'Dashboard',
      '/vehicles': 'Vehicles',
      '/services': 'Services',
    };
    headerTitle.textContent = titles[active] ?? 'FleetPro';
  }
}
