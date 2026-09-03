import { alertAPI } from '../api';
import { isFleetManager } from '../state';
import { toastSuccess, toastError } from '../components/toast';
import { updateAlertBadge } from '../components/layout';

export interface OverdueAlert {
  id: string;
  serviceRecordId: string;
  status: string;
  description: string;
  dueDate: string;
  cycle: number;
  overdueCutoff: string;
  daysOverdue: number;
  vehicle: {
    id: string;
    registration: string;
    make: string;
    model: string;
    serviceCycle: number;
    dismissedAlertCycle: number;
  };
  registration: string;
  technicians: string[];
}

export async function renderAlertsPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="loading-overlay"><div class="spinner"></div></div>`;

  try {
    const res = await alertAPI.list();
    const alerts: OverdueAlert[] = res.data?.alerts || [];
    const count: number = res.data?.count ?? alerts.length;

    // Refresh nav badge
    updateAlertBadge(count);

    renderContent(container, alerts);
  } catch (error) {
    console.error('Failed to load alerts:', error);
    toastError('Error', 'Could not load overdue service alerts.');
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Failed to load alerts</h3>
        <p>There was a problem retrieving overdue alerts. Please try again.</p>
        <button class="btn btn-secondary" id="retry-alerts-btn" style="margin-top: var(--space-3);">Retry</button>
      </div>
    `;
    document.getElementById('retry-alerts-btn')?.addEventListener('click', () => renderAlertsPage(container));
  }
}

function renderContent(container: HTMLElement, alerts: OverdueAlert[]): void {
  const manager = isFleetManager();

  container.innerHTML = `
    <div class="page-title-row">
      <div>
        <h1>Overdue Service Alerts</h1>
        <p style="color: var(--text-secondary); font-size: var(--font-sm); margin-top: 4px;">
          Active alerts for maintenance past due date and grace period (Cycle-aware dismissal)
        </p>
      </div>
      <span class="badge ${alerts.length > 0 ? 'badge-overdue' : 'badge-completed'}" style="font-size: var(--font-sm); padding: 6px 12px;">
        ${alerts.length} Active Alert${alerts.length === 1 ? '' : 's'}
      </span>
    </div>

    ${alerts.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <h3>No Overdue Service Alerts</h3>
        <p>All fleet services are within schedule or grace period, or have been dismissed for the current maintenance cycle.</p>
      </div>
    ` : `
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Vehicle</th>
              <th>Service Details</th>
              <th>Status</th>
              <th>Due Date</th>
              <th>Overdue Cutoff</th>
              <th>Overdue Duration</th>
              <th>Cycle</th>
              <th>Assigned To</th>
              ${manager ? '<th>Action</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${alerts.map((a) => {
              const dueFormatted = a.dueDate ? new Date(a.dueDate).toLocaleDateString() : '—';
              const cutoffFormatted = a.overdueCutoff ? new Date(a.overdueCutoff).toLocaleDateString() : '—';
              return `
              <tr>
                <td>
                  <strong>${a.registration}</strong>
                  <div style="font-size: var(--font-xs); color: var(--text-muted);">${a.vehicle.make} ${a.vehicle.model}</div>
                </td>
                <td>
                  <div style="font-weight: var(--weight-medium);">${a.description}</div>
                  <div style="font-size: var(--font-xs); color: var(--text-secondary); font-family: monospace;">ID: ${a.serviceRecordId.slice(0, 8)}...</div>
                </td>
                <td>
                  <span class="badge ${a.status === 'DUE' ? 'badge-due' : 'badge-booked'}">${a.status}</span>
                </td>
                <td>${dueFormatted}</td>
                <td>${cutoffFormatted}</td>
                <td>
                  <span class="badge badge-overdue" style="font-size: 11px;">
                    ${a.daysOverdue > 0 ? `${a.daysOverdue}d overdue` : 'Overdue'}
                  </span>
                </td>
                <td>
                  <span class="badge" style="background: rgba(255,255,255,0.06); color: var(--text-secondary);">Cycle ${a.vehicle.serviceCycle}</span>
                </td>
                <td>
                  ${a.technicians.length > 0 ? a.technicians.join(', ') : '<span style="color:var(--text-muted)">Unassigned</span>'}
                </td>
                ${manager ? `
                <td>
                  <button class="btn btn-warning btn-sm dismiss-alert-btn" data-id="${a.serviceRecordId}">
                    Dismiss
                  </button>
                </td>
                ` : ''}
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `}
  `;

  if (manager) {
    container.querySelectorAll('.dismiss-alert-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.id!;
        (btn as HTMLButtonElement).disabled = true;
        (btn as HTMLButtonElement).textContent = 'Dismissing...';

        try {
          await alertAPI.dismiss(id);
          toastSuccess('Alert Dismissed', 'Dismissal applies to the current service cycle.');
          await renderAlertsPage(container);
        } catch (err: any) {
          (btn as HTMLButtonElement).disabled = false;
          (btn as HTMLButtonElement).textContent = 'Dismiss';
          const axErr = err as { response?: { data?: { error?: string } } };
          toastError('Dismissal failed', axErr.response?.data?.error || 'Could not dismiss alert.');
        }
      });
    });
  }
}
