import { serviceAPI, vehicleAPI, authAPI } from '../api';
import { isFleetManager } from '../state';
import { openModal, closeModal } from '../components/modal';
import { toastSuccess, toastError, toastInfo } from '../components/toast';

interface ServiceRecord {
  id: string;
  vehicleId: string;
  description: string;
  status: string;
  dateScheduled: string | null;
  dateCompleted: string | null;
  completedOdometer: number | null;
  vehicle: { registration: string; make: string; model: string };
  assignments: Array<{ userId: string; user: { id: string; email: string } }>;
}

interface Vehicle {
  id: string;
  registration: string;
  make: string;
  model: string;
}

let currentPage = 1;
const PAGE_SIZE = 10;
let totalRecords = 0;
let filterStatus = '';
let filterSearch = '';

const STATUS_BADGE_CLASS: Record<string, string> = {
  DUE: 'badge-due',
  OVERDUE: 'badge-overdue',
  BOOKED: 'badge-booked',
  IN_SERVICE: 'badge-in-service',
  COMPLETED: 'badge-completed',
};

const VALID_TRANSITIONS: Record<string, string[]> = {
  DUE: ['BOOKED', 'OVERDUE'],
  OVERDUE: ['BOOKED'],
  BOOKED: ['IN_SERVICE'],
  IN_SERVICE: ['COMPLETED'],
};

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export async function renderServicesPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="loading-overlay"><div class="spinner"></div></div>`;
  await loadAndRender(container);
}

async function loadAndRender(container: HTMLElement): Promise<void> {
  try {
    const params: Record<string, unknown> = {
      page: currentPage,
      limit: PAGE_SIZE,
    };
    if (filterStatus) params.status = filterStatus;
    if (filterSearch) params.description = filterSearch;

    const res = await serviceAPI.search(params);
    const { records, total } = res.data as { records: ServiceRecord[]; total: number };
    totalRecords = total;

    renderContent(container, records);
  } catch {
    // Fallback to list endpoint
    try {
      const res = await serviceAPI.list();
      const records = res.data as ServiceRecord[];
      totalRecords = records.length;
      renderContent(container, records);
    } catch {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <h3>Could not load services</h3>
          <p>Make sure the backend server is running.</p>
        </div>
      `;
      toastError('Connection error', 'Could not reach the backend server.');
    }
  }
}

function renderContent(container: HTMLElement, records: ServiceRecord[]): void {
  const totalPages = Math.ceil(totalRecords / PAGE_SIZE);

  container.innerHTML = `
    <div class="page-title-row">
      <h1>Services</h1>
      <div style="display:flex; gap: var(--space-3);">
        ${isFleetManager() ? `
          <button class="btn btn-secondary" id="export-csv-btn">📥 Export CSV</button>
          <button class="btn btn-primary" id="add-service-btn">+ New Service</button>
        ` : ''}
      </div>
    </div>

    <div class="filter-bar">
      <input type="text" class="form-input" id="service-search" placeholder="Search description…" value="${filterSearch}" />
      <select class="form-select" id="status-filter">
        <option value="">All Statuses</option>
        <option value="DUE" ${filterStatus === 'DUE' ? 'selected' : ''}>Due</option>
        <option value="OVERDUE" ${filterStatus === 'OVERDUE' ? 'selected' : ''}>Overdue</option>
        <option value="BOOKED" ${filterStatus === 'BOOKED' ? 'selected' : ''}>Booked</option>
        <option value="IN_SERVICE" ${filterStatus === 'IN_SERVICE' ? 'selected' : ''}>In Service</option>
        <option value="COMPLETED" ${filterStatus === 'COMPLETED' ? 'selected' : ''}>Completed</option>
      </select>
    </div>

    ${records.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">🔧</div>
        <h3>No service records</h3>
        <p>${filterSearch || filterStatus ? 'Try adjusting your filters.' : 'Create a service record to get started.'}</p>
      </div>
    ` : `
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Vehicle</th>
              <th>Description</th>
              <th>Status</th>
              <th>Scheduled</th>
              <th>Completed</th>
              <th>Technicians</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${records.map((r) => `
              <tr>
                <td><strong>${r.vehicle.registration}</strong><br/><span style="color:var(--text-muted);font-size:var(--font-xs);">${r.vehicle.make} ${r.vehicle.model}</span></td>
                <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.description}</td>
                <td><span class="badge ${STATUS_BADGE_CLASS[r.status] || ''}">${formatStatus(r.status)}</span></td>
                <td>${formatDate(r.dateScheduled)}</td>
                <td>${formatDate(r.dateCompleted)}${r.completedOdometer ? `<br/><span style="color:var(--text-muted);font-size:var(--font-xs);">${r.completedOdometer.toLocaleString()} km</span>` : ''}</td>
                <td>
                  ${r.assignments.length > 0
                    ? r.assignments.map((a) => `<span class="badge badge-role" style="margin: 1px;">${a.user.email.split('@')[0]}</span>`).join(' ')
                    : '<span style="color:var(--text-muted);">—</span>'}
                </td>
                <td>
                  <div class="action-group">
                    ${getTransitionButtons(r)}
                    ${isFleetManager() ? `<button class="btn btn-ghost btn-sm assign-btn" data-id="${r.id}">👤+</button>` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      ${totalPages > 1 ? `
      <div class="pagination">
        <button ${currentPage <= 1 ? 'disabled' : ''} id="prev-page">‹</button>
        <span class="page-info">Page ${currentPage} of ${totalPages}</span>
        <button ${currentPage >= totalPages ? 'disabled' : ''} id="next-page">›</button>
      </div>
      ` : ''}
    `}
  `;

  // Event listeners
  document.getElementById('service-search')?.addEventListener('input', debounce((e: Event) => {
    filterSearch = (e.target as HTMLInputElement).value;
    currentPage = 1;
    loadAndRender(container);
  }, 300));

  document.getElementById('status-filter')?.addEventListener('change', (e) => {
    filterStatus = (e.target as HTMLSelectElement).value;
    currentPage = 1;
    loadAndRender(container);
  });

  document.getElementById('prev-page')?.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; loadAndRender(container); }
  });

  document.getElementById('next-page')?.addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; loadAndRender(container); }
  });

  document.getElementById('add-service-btn')?.addEventListener('click', () => showAddServiceModal(container));
  document.getElementById('export-csv-btn')?.addEventListener('click', handleExportCSV);

  // Transition buttons
  container.querySelectorAll('.transition-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const serviceId = (btn as HTMLElement).dataset.id!;
      const newStatus = (btn as HTMLElement).dataset.status!;

      if (newStatus === 'COMPLETED') {
        showCompleteModal(serviceId, container);
        return;
      }

      try {
        await serviceAPI.update(serviceId, { status: newStatus });
        toastSuccess('Status updated', `→ ${formatStatus(newStatus)}`);
        await loadAndRender(container);
      } catch (err: unknown) {
        const axErr = err as { response?: { data?: { error?: string } } };
        toastError('Update failed', axErr.response?.data?.error ?? 'Could not update status.');
      }
    });
  });

  // Assign buttons
  container.querySelectorAll('.assign-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const serviceId = (btn as HTMLElement).dataset.id!;
      const record = records.find((r) => r.id === serviceId);
      if (record) showAssignModal(record, container);
    });
  });
}

function getTransitionButtons(record: ServiceRecord): string {
  if (!isFleetManager()) return '';
  const transitions = VALID_TRANSITIONS[record.status] || [];
  return transitions.map((status) => {
    const labels: Record<string, string> = {
      BOOKED: '📅 Book',
      OVERDUE: '⚠ Overdue',
      IN_SERVICE: '🔧 Start',
      COMPLETED: '✅ Complete',
    };
    const classes: Record<string, string> = {
      BOOKED: 'btn-secondary',
      OVERDUE: 'btn-danger',
      IN_SERVICE: 'btn-secondary',
      COMPLETED: 'btn-success',
    };
    return `<button class="btn ${classes[status] || 'btn-ghost'} btn-sm transition-btn" data-id="${record.id}" data-status="${status}">${labels[status] || status}</button>`;
  }).join('');
}

function showCompleteModal(serviceId: string, pageContainer: HTMLElement): void {
  openModal('Complete Service', `
    <p style="color: var(--text-secondary); font-size: var(--font-sm); margin-bottom: var(--space-4);">
      Enter the current odometer reading to complete this service.
    </p>
    <div class="form-group">
      <label class="form-label" for="completed-odometer">Odometer Reading (km)</label>
      <input type="number" id="completed-odometer" class="form-input" placeholder="55000" required min="0" />
    </div>
  `, `
    <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn-success" id="modal-submit">✅ Complete</button>
  `);

  document.getElementById('modal-cancel')!.addEventListener('click', closeModal);
  document.getElementById('modal-submit')!.addEventListener('click', async () => {
    const odometer = (document.getElementById('completed-odometer') as HTMLInputElement).value;
    if (!odometer) {
      toastError('Validation', 'Please enter the odometer reading.');
      return;
    }

    try {
      await serviceAPI.update(serviceId, { status: 'COMPLETED', completedOdometer: odometer });
      closeModal();
      toastSuccess('Service completed');
      await loadAndRender(pageContainer);
    } catch (err: unknown) {
      const axErr = err as { response?: { data?: { error?: string } } };
      toastError('Failed', axErr.response?.data?.error ?? 'Could not complete service.');
    }
  });
}

async function showAddServiceModal(pageContainer: HTMLElement): Promise<void> {
  let vehicles: Vehicle[] = [];
  try {
    const res = await vehicleAPI.list();
    vehicles = (res.data as Vehicle[]).filter((v: Vehicle & { archived?: boolean }) => !(v as Vehicle & { archived: boolean }).archived);
  } catch {
    toastError('Error', 'Could not load vehicles.');
    return;
  }

  openModal('New Service Record', `
    <div class="form-group">
      <label class="form-label" for="s-vehicle">Vehicle</label>
      <select id="s-vehicle" class="form-select" required>
        <option value="">Select a vehicle…</option>
        ${vehicles.map((v) => `<option value="${v.id}">${v.registration} — ${v.make} ${v.model}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="s-description">Description</label>
      <textarea id="s-description" class="form-textarea" placeholder="Regular maintenance, oil change…" required></textarea>
    </div>
    <div class="form-group">
      <label class="form-label" for="s-status">Initial Status</label>
      <select id="s-status" class="form-select">
        <option value="DUE">Due</option>
        <option value="BOOKED">Booked</option>
      </select>
    </div>
  `, `
    <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn-primary" id="modal-submit">Create</button>
  `);

  document.getElementById('modal-cancel')!.addEventListener('click', closeModal);
  document.getElementById('modal-submit')!.addEventListener('click', async () => {
    const vehicleId = (document.getElementById('s-vehicle') as HTMLSelectElement).value;
    const description = (document.getElementById('s-description') as HTMLTextAreaElement).value.trim();
    const status = (document.getElementById('s-status') as HTMLSelectElement).value;

    if (!vehicleId || !description) {
      toastError('Validation', 'Please fill in all fields.');
      return;
    }

    try {
      await serviceAPI.create({ vehicleId, description, status });
      closeModal();
      toastSuccess('Service created');
      await loadAndRender(pageContainer);
    } catch {
      toastError('Failed', 'Could not create service record.');
    }
  });
}

async function showAssignModal(record: ServiceRecord, pageContainer: HTMLElement): Promise<void> {
  let registeredTechs: Array<{ id: string; email: string }> = [];
  try {
    const res = await authAPI.getTechnicians();
    registeredTechs = (res.data as Array<{ id: string; email: string }>) || [];
  } catch {
    // Ignore fetch error
  }

  const selectOptions = registeredTechs
    .filter((t) => !record.assignments.some((a) => a.userId === t.id))
    .map((t) => `<option value="${t.email}">${t.email}</option>`)
    .join('');

  openModal('Manage Technicians', `
    <p style="color: var(--text-secondary); font-size: var(--font-sm); margin-bottom: var(--space-4);">
      <strong>${record.vehicle.registration}</strong> — ${record.description}
    </p>

    <div style="margin-bottom: var(--space-5);">
      <strong style="font-size: var(--font-sm);">Assigned Technicians:</strong>
      ${record.assignments.length > 0
        ? `<div style="margin-top: var(--space-2); display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${record.assignments.map((a) => `
              <span class="badge badge-role" style="display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3);">
                👤 ${a.user.email}
                <button class="remove-tech-btn" data-tech-id="${a.userId}" title="Remove technician" style="background:none; border:none; color:var(--error); cursor:pointer; font-size:var(--font-sm); line-height:1; padding:0 2px;">✕</button>
              </span>
            `).join('')}
          </div>`
        : '<p style="color: var(--text-muted); font-size: var(--font-sm); margin-top: var(--space-1);">No technicians assigned to this service yet.</p>'}
    </div>

    ${selectOptions.length > 0 ? `
    <div class="form-group">
      <label class="form-label" for="tech-select">Select Registered Technician</label>
      <select id="tech-select" class="form-select">
        <option value="">-- Choose from registered technicians --</option>
        ${selectOptions}
      </select>
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label" for="tech-email">${selectOptions.length > 0 ? 'Or Enter Technician Email' : 'Technician Email'}</label>
      <input type="text" id="tech-email" class="form-input" placeholder="e.g. divyani@gmail.com" />
    </div>
  `, `
    <button class="btn btn-secondary" id="modal-cancel">Close</button>
    <button class="btn btn-primary" id="modal-submit">Assign</button>
  `);

  document.getElementById('modal-cancel')!.addEventListener('click', closeModal);

  // Sync select with input
  const techSelect = document.getElementById('tech-select') as HTMLSelectElement | null;
  const techInput = document.getElementById('tech-email') as HTMLInputElement;
  if (techSelect) {
    techSelect.addEventListener('change', () => {
      if (techSelect.value) {
        techInput.value = techSelect.value;
      }
    });
  }

  // Remove technician
  document.querySelectorAll('.remove-tech-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const techId = (btn as HTMLElement).dataset.techId!;
      try {
        await serviceAPI.removeTechnician(record.id, techId);
        toastSuccess('Technician removed');
        closeModal();
        await loadAndRender(pageContainer);
      } catch (err: unknown) {
        const axErr = err as { response?: { data?: { error?: string } } };
        toastError('Failed', axErr.response?.data?.error ?? 'Could not remove technician.');
      }
    });
  });

  // Assign
  document.getElementById('modal-submit')!.addEventListener('click', async () => {
    const techValue = techInput.value.trim();
    if (!techValue) {
      toastError('Validation', 'Please select or enter a technician email.');
      return;
    }
    try {
      await serviceAPI.assignTechnician(record.id, techValue);
      toastSuccess('Technician assigned successfully');
      closeModal();
      await loadAndRender(pageContainer);
    } catch (err: unknown) {
      const axErr = err as { response?: { data?: { error?: string } } };
      toastError('Failed', axErr.response?.data?.error ?? 'Could not assign technician.');
    }
  });
}

async function handleExportCSV(): Promise<void> {
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
    toastError('Export failed', 'Could not export service records.');
  }
}

function debounce(fn: (e: Event) => void, delay: number): (e: Event) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (e: Event) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(e), delay);
  };
}
