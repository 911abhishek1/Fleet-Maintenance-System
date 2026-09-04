import { dashboardAPI, vehicleAPI } from '../api';
import { isFleetManager } from '../state';
import { navigate } from '../router';
import { toastError, toastSuccess } from '../components/toast';

export interface DashboardData {
  vehiclesDue: number;
  vehiclesInService: number;
  completedThisWeek: number;
  overdue: number;
  statusBreakdown: {
    DUE: number;
    BOOKED: number;
    IN_SERVICE: number;
    COMPLETED: number;
  };
  technicianBreakdown: Array<{
    technicianId: string;
    email: string;
    totalAssigned: number;
    inService: number;
    completed: number;
    statusBreakdown: {
      DUE: number;
      BOOKED: number;
      IN_SERVICE: number;
      COMPLETED: number;
    };
  }>;
  completedLast8Weeks: Array<{
    weekIndex: number;
    weekLabel: string;
    startDate: string;
    endDate: string;
    count: number;
  }>;
}

export async function renderDashboardPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="loading-overlay"><div class="spinner"></div></div>`;

  try {
    const res = await dashboardAPI.get();
    const data: DashboardData = res.data;
    renderContent(container, data);
  } catch (error) {
    console.error('Failed to load dashboard:', error);
    toastError('Error', 'Could not load dashboard metrics.');
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Failed to load dashboard</h3>
        <p>Could not retrieve server-side fleet metrics. Please try again.</p>
        <button class="btn btn-secondary" id="retry-dash-btn" style="margin-top: var(--space-4);">Retry</button>
      </div>
    `;
    document.getElementById('retry-dash-btn')?.addEventListener('click', () => renderDashboardPage(container));
  }
}

function renderContent(container: HTMLElement, data: DashboardData): void {
  const manager = isFleetManager();
  const totalServices =
    data.statusBreakdown.DUE +
    data.statusBreakdown.BOOKED +
    data.statusBreakdown.IN_SERVICE +
    data.statusBreakdown.COMPLETED;

  const duePct = totalServices > 0 ? ((data.statusBreakdown.DUE / totalServices) * 100).toFixed(1) : '0';
  const bookedPct = totalServices > 0 ? ((data.statusBreakdown.BOOKED / totalServices) * 100).toFixed(1) : '0';
  const inServicePct = totalServices > 0 ? ((data.statusBreakdown.IN_SERVICE / totalServices) * 100).toFixed(1) : '0';
  const completedPct = totalServices > 0 ? ((data.statusBreakdown.COMPLETED / totalServices) * 100).toFixed(1) : '0';

  // SVG Chart Calculation for 8 weeks
  const maxCount = Math.max(...data.completedLast8Weeks.map((w) => w.count), 4);
  const chartHeight = 150;
  const barWidth = 40;
  const barGap = 35;
  const startX = 45;

  const barsSvg = data.completedLast8Weeks
    .map((w, idx) => {
      const x = startX + idx * (barWidth + barGap);
      const barH = w.count > 0 ? Math.max((w.count / maxCount) * chartHeight, 6) : 2;
      const y = 180 - barH;
      const isCurrentWeek = idx === 7;
      const fillColor = isCurrentWeek ? 'var(--accent-indigo)' : 'var(--status-completed)';

      // Shorten label for chart axis
      const shortLabel = idx === 7 ? 'This Wk' : w.weekLabel.split(' - ')[0] || `W${idx + 1}`;

      return `
        <g class="chart-bar-group">
          <rect
            x="${x}"
            y="${y}"
            width="${barWidth}"
            height="${barH}"
            rx="4"
            fill="${fillColor}"
            opacity="${w.count > 0 ? '0.9' : '0.2'}"
          />
          <text
            x="${x + barWidth / 2}"
            y="${y - 8}"
            fill="var(--text-secondary)"
            font-size="11"
            font-weight="600"
            text-anchor="middle"
          >${w.count}</text>
          <text
            x="${x + barWidth / 2}"
            y="200"
            fill="var(--text-muted)"
            font-size="10"
            text-anchor="middle"
          >${shortLabel}</text>
        </g>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="page-title-row">
      <div>
        <h1>Fleet Maintenance Dashboard</h1>
        <p style="color: var(--text-secondary); font-size: var(--font-sm); margin-top: 4px;">
          ${manager ? 'Real-time fleet-wide operational health and service velocity' : 'Your assigned operational tasks and maintenance workload'}
        </p>
      </div>
    </div>

    <!-- 1. 4 KPI Cards -->
    <div class="stat-grid">
      <div class="stat-card" style="--stat-accent: var(--status-due); --stat-accent-soft: var(--status-due-soft); cursor: pointer;" id="kpi-due">
        <div class="stat-icon">📋</div>
        <div class="stat-info">
          <div class="stat-value">${data.vehiclesDue}</div>
          <div class="stat-label">Vehicles Due</div>
        </div>
      </div>

      <div class="stat-card" style="--stat-accent: var(--status-in-service); --stat-accent-soft: var(--status-in-service-soft); cursor: pointer;" id="kpi-in-service">
        <div class="stat-icon">🔧</div>
        <div class="stat-info">
          <div class="stat-value">${data.vehiclesInService}</div>
          <div class="stat-label">In Service</div>
        </div>
      </div>

      <div class="stat-card" style="--stat-accent: var(--status-completed); --stat-accent-soft: var(--status-completed-soft); cursor: pointer;" id="kpi-completed-week">
        <div class="stat-icon">✅</div>
        <div class="stat-info">
          <div class="stat-value">${data.completedThisWeek}</div>
          <div class="stat-label">Completed This Week</div>
        </div>
      </div>

      <div class="stat-card" style="--stat-accent: var(--status-overdue); --stat-accent-soft: var(--status-overdue-soft); cursor: pointer;" id="kpi-overdue">
        <div class="stat-icon">⚠️</div>
        <div class="stat-info">
          <div class="stat-value">${data.overdue}</div>
          <div class="stat-label">Overdue Alerts</div>
        </div>
      </div>
    </div>

    <!-- 2. Status Breakdown & 8-Week Completed Chart -->
    <div class="dashboard-row">
      <!-- Status Breakdown Card -->
      <div class="card">
        <div class="card-header">
          <h2>Service Status Breakdown</h2>
          <span class="badge" style="background: rgba(255,255,255,0.06); color: var(--text-secondary);">${totalServices} Total Services</span>
        </div>
        <div class="card-body">
          <div class="status-progress-bar">
            <div class="status-segment" style="width: ${duePct}%; background: var(--status-due);" title="DUE: ${data.statusBreakdown.DUE}"></div>
            <div class="status-segment" style="width: ${bookedPct}%; background: var(--status-booked);" title="BOOKED: ${data.statusBreakdown.BOOKED}"></div>
            <div class="status-segment" style="width: ${inServicePct}%; background: var(--status-in-service);" title="IN_SERVICE: ${data.statusBreakdown.IN_SERVICE}"></div>
            <div class="status-segment" style="width: ${completedPct}%; background: var(--status-completed);" title="COMPLETED: ${data.statusBreakdown.COMPLETED}"></div>
          </div>

          <div class="status-legend-grid">
            <div class="status-legend-item">
              <div><span class="status-dot" style="background: var(--status-due);"></span><strong>DUE</strong></div>
              <div><strong>${data.statusBreakdown.DUE}</strong> <span style="font-size: var(--font-xs); color: var(--text-muted);">(${duePct}%)</span></div>
            </div>
            <div class="status-legend-item">
              <div><span class="status-dot" style="background: var(--status-booked);"></span><strong>BOOKED</strong></div>
              <div><strong>${data.statusBreakdown.BOOKED}</strong> <span style="font-size: var(--font-xs); color: var(--text-muted);">(${bookedPct}%)</span></div>
            </div>
            <div class="status-legend-item">
              <div><span class="status-dot" style="background: var(--status-in-service);"></span><strong>IN_SERVICE</strong></div>
              <div><strong>${data.statusBreakdown.IN_SERVICE}</strong> <span style="font-size: var(--font-xs); color: var(--text-muted);">(${inServicePct}%)</span></div>
            </div>
            <div class="status-legend-item">
              <div><span class="status-dot" style="background: var(--status-completed);"></span><strong>COMPLETED</strong></div>
              <div><strong>${data.statusBreakdown.COMPLETED}</strong> <span style="font-size: var(--font-xs); color: var(--text-muted);">(${completedPct}%)</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 8-Week Trend Chart Card -->
      <div class="card">
        <div class="card-header">
          <h2>Completed Services (Last 8 Weeks)</h2>
          <span style="font-size: var(--font-xs); color: var(--text-muted);">Weekly completions</span>
        </div>
        <div class="card-body">
          <div class="chart-box">
            <svg class="bar-chart-svg" viewBox="0 0 650 220">
              <!-- Grid lines -->
              <line x1="30" y1="30" x2="630" y2="30" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
              <line x1="30" y1="105" x2="630" y2="105" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
              <line x1="30" y1="180" x2="630" y2="180" stroke="var(--border-primary)" />
              
              <!-- Y-Axis Labels -->
              <text x="25" y="34" fill="var(--text-muted)" font-size="10" text-anchor="end">${maxCount}</text>
              <text x="25" y="109" fill="var(--text-muted)" font-size="10" text-anchor="end">${Math.round(maxCount / 2)}</text>
              <text x="25" y="184" fill="var(--text-muted)" font-size="10" text-anchor="end">0</text>

              <!-- Bars & Labels -->
              ${barsSvg}
            </svg>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. Technician Breakdown -->
    <div class="card">
      <div class="card-header">
        <h2>${manager ? 'Technician Workload Breakdown' : 'Your Assigned Workload'}</h2>
        <span style="font-size: var(--font-xs); color: var(--text-muted);">
          ${manager ? `${data.technicianBreakdown.length} Technicians` : 'Assigned Records'}
        </span>
      </div>
      <div class="card-body" style="padding: 0;">
        ${data.technicianBreakdown.length === 0 ? `
          <div style="padding: var(--space-8); text-align: center; color: var(--text-muted);">
            No technician assignments found.
          </div>
        ` : `
          <table class="data-table">
            <thead>
              <tr>
                <th>Technician</th>
                <th>Total Assigned</th>
                <th>In Service</th>
                <th>Completed</th>
                <th>Status Breakdown</th>
              </tr>
            </thead>
            <tbody>
              ${data.technicianBreakdown.map((t) => `
                <tr>
                  <td>
                    <strong>${t.email}</strong>
                    <div style="font-size: var(--font-xs); color: var(--text-muted); font-family: monospace;">ID: ${t.technicianId.slice(0, 8)}...</div>
                  </td>
                  <td><strong>${t.totalAssigned}</strong></td>
                  <td><span class="badge badge-in-service">${t.inService}</span></td>
                  <td><span class="badge badge-completed">${t.completed}</span></td>
                  <td>
                    <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
                      <span class="badge badge-due" style="font-size: 11px;">DUE: ${t.statusBreakdown.DUE}</span>
                      <span class="badge badge-booked" style="font-size: 11px;">BOOKED: ${t.statusBreakdown.BOOKED}</span>
                      <span class="badge badge-in-service" style="font-size: 11px;">IN_SERVICE: ${t.statusBreakdown.IN_SERVICE}</span>
                      <span class="badge badge-completed" style="font-size: 11px;">COMPLETED: ${t.statusBreakdown.COMPLETED}</span>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>

    <!-- 4. Quick Actions (Fleet Manager Only) -->
    ${manager ? `
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
          <div class="quick-action-card" id="qa-alerts">
            <div class="action-icon">⚠️</div>
            <div class="action-label">Overdue Alerts</div>
          </div>
        </div>
      </div>
    </div>
    ` : ''}
  `;

  // Navigation handlers for KPI cards
  document.getElementById('kpi-due')?.addEventListener('click', () => navigate('/services?status=DUE'));
  document.getElementById('kpi-in-service')?.addEventListener('click', () => navigate('/services?status=IN_SERVICE'));
  document.getElementById('kpi-completed-week')?.addEventListener('click', () => navigate('/services?status=COMPLETED'));
  document.getElementById('kpi-overdue')?.addEventListener('click', () => navigate('/alerts'));

  // Quick Action handlers
  if (manager) {
    document.getElementById('qa-add-vehicle')?.addEventListener('click', () => navigate('/vehicles'));
    document.getElementById('qa-services')?.addEventListener('click', () => navigate('/services'));
    document.getElementById('qa-alerts')?.addEventListener('click', () => navigate('/alerts'));
    document.getElementById('qa-export')?.addEventListener('click', () => navigate('/services'));
    document.getElementById('qa-evaluate')?.addEventListener('click', async () => {
      const btn = document.getElementById('qa-evaluate');
      if (btn) btn.style.opacity = '0.5';
      try {
        const res = await vehicleAPI.evaluateStatus();
        toastSuccess('Evaluated', `${res.data.flaggedDue} vehicles flagged as due for service.`);
        await renderDashboardPage(container);
      } catch {
        toastError('Evaluation Failed', 'Could not evaluate vehicle statuses.');
        if (btn) btn.style.opacity = '1';
      }
    });
  }
}
