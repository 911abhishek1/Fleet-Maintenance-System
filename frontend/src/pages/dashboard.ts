import { vehicleAPI, serviceAPI } from '../api';
import { isFleetManager } from '../state';
import { navigate } from '../router';
import { toastError, toastSuccess, toastInfo } from '../components/toast';

export async function renderDashboardPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="loading-overlay"><div class="spinner"></div></div>`;

  try {
    const [vehiclesRes, servicesRes] = await Promise.all([
      vehicleAPI.list().catch(() => ({ data: [] })),
      serviceAPI.list().catch(() => ({ data: [] })),
    ]);

    const vehicles = vehiclesRes.data as Array<{ archived: boolean }>;
    const services = servicesRes.data as Array<{ status: string }>;

    const activeVehicles = vehicles.filter((v) => !v.archived).length;
    const totalVehicles = vehicles.length;
    const due = services.filter((s) => s.status === 'DUE').length;
    const overdue = services.filter((s) => s.status === 'OVERDUE').length;
    const booked = services.filter((s) => s.status === 'BOOKED').length;
    const inService = services.filter((s) => s.status === 'IN_SERVICE').length;
    const completed = services.filter((s) => s.status === 'COMPLETED').length;

    container.innerHTML = `
      <div class="page-title-row">
        <h1>Dashboard</h1>
      </div>

      <div class="stat-grid">
        <div class="stat-card" style="--stat-accent: var(--accent-indigo); --stat-accent-soft: var(--accent-indigo-soft);">
          <div class="stat-icon">🚗</div>
          <div class="stat-value">${activeVehicles}</div>
          <div class="stat-label">Active Vehicles (${totalVehicles} total)</div>
        </div>

        <div class="stat-card" style="--stat-accent: var(--status-due); --stat-accent-soft: var(--status-due-soft);">
          <div class="stat-icon">📋</div>
          <div class="stat-value">${due}</div>
          <div class="stat-label">Services Due</div>
        </div>

        <div class="stat-card" style="--stat-accent: var(--status-overdue); --stat-accent-soft: var(--status-overdue-soft);">
          <div class="stat-icon">⚠️</div>
          <div class="stat-value">${overdue}</div>
          <div class="stat-label">Overdue</div>
        </div>

        <div class="stat-card" style="--stat-accent: var(--status-booked); --stat-accent-soft: var(--status-booked-soft);">
          <div class="stat-icon">📅</div>
          <div class="stat-value">${booked}</div>
          <div class="stat-label">Booked</div>
        </div>

        <div class="stat-card" style="--stat-accent: var(--status-in-service); --stat-accent-soft: var(--status-in-service-soft);">
          <div class="stat-icon">🔧</div>
          <div class="stat-value">${inService}</div>
          <div class="stat-label">In Service</div>
        </div>

        <div class="stat-card" style="--stat-accent: var(--status-completed); --stat-accent-soft: var(--status-completed-soft);">
          <div class="stat-icon">✅</div>
          <div class="stat-value">${completed}</div>
          <div class="stat-label">Completed</div>
        </div>
      </div>

      ${isFleetManager() ? `
      <div class="card">
        <div class="card-header">
          <h2>Quick Actions</h2>
        </div>
        <div class="card-body">
          <div class="quick-actions">
            <div class="quick-action-card" id="qa-add-vehicle">
              <div class="action-icon">➕</div>
              <div class="action-label">Add Vehicle</div>
            </div>
            <div class="quick-action-card" id="qa-evaluate">
              <div class="action-icon">🔄</div>
              <div class="action-label">Evaluate Status</div>
            </div>
            <div class="quick-action-card" id="qa-export">
              <div class="action-icon">📥</div>
              <div class="action-label">Export CSV</div>
            </div>
            <div class="quick-action-card" id="qa-services">
              <div class="action-icon">🔧</div>
              <div class="action-label">View Services</div>
            </div>
          </div>
        </div>
      </div>
      ` : `
      <div class="card">
        <div class="card-header"><h2>Your Assignments</h2></div>
        <div class="card-body">
          <p style="color: var(--text-secondary);">You have <strong>${services.length}</strong> service${services.length === 1 ? '' : 's'} assigned to you.</p>
          <br/>
          <button class="btn btn-primary" id="qa-services">View My Services</button>
        </div>
      </div>
      `}
    `;

    // Quick action handlers
    document.getElementById('qa-add-vehicle')?.addEventListener('click', () => navigate('/vehicles'));
    document.getElementById('qa-services')?.addEventListener('click', () => navigate('/services'));

    document.getElementById('qa-evaluate')?.addEventListener('click', async () => {
      try {
        const res = await vehicleAPI.evaluateStatus();
        toastSuccess('Evaluation complete', `Due: ${res.data.flaggedDue}, Overdue: ${res.data.flaggedOverdue}`);
        renderDashboardPage(container); // refresh
      } catch {
        toastError('Evaluation failed', 'Could not evaluate vehicle status.');
      }
    });

    document.getElementById('qa-export')?.addEventListener('click', async () => {
      try {
        const res = await serviceAPI.exportCSV();
        const blob = new Blob([res.data], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'service-history.csv';
        a.click();
        URL.revokeObjectURL(url);
        toastInfo('Download started', 'CSV file is downloading.');
      } catch {
        toastError('Export failed', 'Could not export CSV.');
      }
    });
  } catch {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Could not load dashboard</h3>
        <p>Make sure the backend server is running.</p>
      </div>
    `;
    toastError('Connection error', 'Could not reach the backend server.');
  }
}
