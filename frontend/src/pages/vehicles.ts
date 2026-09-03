import { vehicleAPI } from '../api';
import { openModal, closeModal } from '../components/modal';
import { toastSuccess, toastError } from '../components/toast';

interface Vehicle {
  id: string;
  registration: string;
  make: string;
  model: string;
  odometer: number;
  dateIntervalDays: number;
  mileageInterval: number;
  archived: boolean;
  serviceRecords: Array<{ status: string }>;
}

let currentPage = 1;
const PAGE_SIZE = 10;
let totalVehicles = 0;
let allVehicles: Vehicle[] = [];
let searchQuery = '';
let showArchived = false;
let sortBy = 'createdAt';
let sortOrder = 'desc';

export async function renderVehiclesPage(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="loading-overlay"><div class="spinner"></div></div>`;
  await loadAndRenderVehicles(container);
}

async function loadAndRenderVehicles(container: HTMLElement): Promise<void> {
  try {
    const params: Record<string, unknown> = {
      page: currentPage,
      limit: PAGE_SIZE,
      sortBy,
      sortOrder,
    };
    if (searchQuery.trim()) {
      params.search = searchQuery.trim();
    }
    params.archived = showArchived ? 'all' : 'false';

    const res = await vehicleAPI.list(params);
    allVehicles = Array.isArray(res.data) ? res.data : (res.data?.vehicles || []);
    totalVehicles = (res.data as any).total ?? allVehicles.length;
  } catch {
    allVehicles = [];
    totalVehicles = 0;
    toastError('Load failed', 'Could not load vehicles.');
  }

  renderContent(container);
}

function renderContent(container: HTMLElement): void {
  const totalPages = Math.max(1, Math.ceil(totalVehicles / PAGE_SIZE));

  container.innerHTML = `
    <div class="page-title-row">
      <h1>Vehicles</h1>
      <div style="display:flex; gap: var(--space-3);">
        <button class="btn btn-secondary" id="bulk-upload-btn">📤 Bulk Odometer</button>
        <button class="btn btn-primary" id="add-vehicle-btn">+ Add Vehicle</button>
      </div>
    </div>

    <div class="filter-bar" style="display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center;">
      <input type="text" class="form-input" id="search-input" placeholder="Search by registration, make, or model…" value="${searchQuery}" style="flex: 1; min-width: 200px;" />
      
      <label style="display:flex; align-items:center; gap:var(--space-2); color:var(--text-secondary); font-size:var(--font-sm); cursor:pointer;">
        <input type="checkbox" id="show-archived" ${showArchived ? 'checked' : ''} />
        Show Archived
      </label>

      <select class="form-select" id="vehicle-sort-by" style="min-width: 140px;">
        <option value="createdAt" ${sortBy === 'createdAt' ? 'selected' : ''}>Sort: Created</option>
        <option value="registration" ${sortBy === 'registration' ? 'selected' : ''}>Sort: Reg</option>
        <option value="make" ${sortBy === 'make' ? 'selected' : ''}>Sort: Make</option>
        <option value="model" ${sortBy === 'model' ? 'selected' : ''}>Sort: Model</option>
        <option value="odometer" ${sortBy === 'odometer' ? 'selected' : ''}>Sort: Odometer</option>
      </select>

      <select class="form-select" id="vehicle-sort-order" style="min-width: 90px;">
        <option value="desc" ${sortOrder === 'desc' ? 'selected' : ''}>Desc</option>
        <option value="asc" ${sortOrder === 'asc' ? 'selected' : ''}>Asc</option>
      </select>

      <span class="total-count-badge" style="color: var(--text-secondary); font-size: var(--font-sm); margin-left: auto;">
        ${totalVehicles} vehicles
      </span>
    </div>

    ${allVehicles.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">🚗</div>
        <h3>No vehicles found</h3>
        <p>${searchQuery ? 'Try adjusting your search.' : 'Add your first vehicle to get started.'}</p>
      </div>
    ` : `
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Registration</th>
              <th>Make / Model</th>
              <th>Odometer</th>
              <th>Service Interval</th>
              <th>Mileage Interval</th>
              <th>Active Services</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${allVehicles.map((v) => {
              const activeServices = (v.serviceRecords || []).filter((s) => s.status !== 'COMPLETED').length;
              return `
              <tr>
                <td><strong>${v.registration}</strong></td>
                <td>${v.make} ${v.model}</td>
                <td>${v.odometer.toLocaleString()} km</td>
                <td>${v.dateIntervalDays} days</td>
                <td>${v.mileageInterval.toLocaleString()} km</td>
                <td>${activeServices > 0 ? `<span class="badge badge-due">${activeServices}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
                <td>${v.archived ? '<span class="badge badge-overdue">Archived</span>' : '<span class="badge badge-completed">Active</span>'}</td>
                <td>
                  <div class="action-group">
                    <button class="btn btn-ghost btn-sm edit-vehicle-btn" data-id="${v.id}">Edit</button>
                    <button class="btn ${v.archived ? 'btn-success' : 'btn-danger'} btn-sm archive-vehicle-btn" data-id="${v.id}" data-archived="${v.archived}">
                      ${v.archived ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <button ${currentPage <= 1 ? 'disabled' : ''} id="prev-vehicle-page">‹</button>
        <span class="page-info">Page ${currentPage} of ${totalPages} (${totalVehicles} total)</span>
        <button ${currentPage >= totalPages ? 'disabled' : ''} id="next-vehicle-page">›</button>
      </div>
    `}
  `;

  // Search
  let searchDebounceTimer: any;
  document.getElementById('search-input')?.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchQuery = (e.target as HTMLInputElement).value;
      currentPage = 1;
      loadAndRenderVehicles(container);
    }, 300);
  });

  // Show archived toggle
  document.getElementById('show-archived')?.addEventListener('change', (e) => {
    showArchived = (e.target as HTMLInputElement).checked;
    currentPage = 1;
    loadAndRenderVehicles(container);
  });

  // Sort by
  document.getElementById('vehicle-sort-by')?.addEventListener('change', (e) => {
    sortBy = (e.target as HTMLSelectElement).value;
    currentPage = 1;
    loadAndRenderVehicles(container);
  });

  // Sort order
  document.getElementById('vehicle-sort-order')?.addEventListener('change', (e) => {
    sortOrder = (e.target as HTMLSelectElement).value;
    currentPage = 1;
    loadAndRenderVehicles(container);
  });

  // Pagination
  document.getElementById('prev-vehicle-page')?.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadAndRenderVehicles(container);
    }
  });

  document.getElementById('next-vehicle-page')?.addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadAndRenderVehicles(container);
    }
  });

  // Add vehicle
  document.getElementById('add-vehicle-btn')?.addEventListener('click', () => showAddVehicleModal(container));

  // Bulk upload
  document.getElementById('bulk-upload-btn')?.addEventListener('click', () => showBulkUploadModal(container));

  // Edit buttons
  container.querySelectorAll('.edit-vehicle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      const vehicle = allVehicles.find((v) => v.id === id);
      if (vehicle) showEditVehicleModal(vehicle, container);
    });
  });

  // Archive/restore buttons
  container.querySelectorAll('.archive-vehicle-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      const isArchived = (btn as HTMLElement).dataset.archived === 'true';
      try {
        await vehicleAPI.archive(id, !isArchived);
        toastSuccess(isArchived ? 'Vehicle restored' : 'Vehicle archived');
        await renderVehiclesPage(container);
      } catch {
        toastError('Failed', 'Could not update vehicle status.');
      }
    });
  });
}

function showAddVehicleModal(pageContainer: HTMLElement): void {
  openModal('Add Vehicle', `
    <form id="add-vehicle-form">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="v-registration">Registration</label>
          <input type="text" id="v-registration" class="form-input" placeholder="ABC-1234" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="v-odometer">Odometer (km)</label>
          <input type="number" id="v-odometer" class="form-input" placeholder="50000" required min="0" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="v-make">Make</label>
          <input type="text" id="v-make" class="form-input" placeholder="Toyota" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="v-model">Model</label>
          <input type="text" id="v-model" class="form-input" placeholder="Hilux" required />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="v-interval-days">Service Interval (days)</label>
          <input type="number" id="v-interval-days" class="form-input" placeholder="90" required min="1" />
        </div>
        <div class="form-group">
          <label class="form-label" for="v-interval-km">Mileage Interval (km)</label>
          <input type="number" id="v-interval-km" class="form-input" placeholder="10000" required min="1" />
        </div>
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn-primary" id="modal-submit">Add Vehicle</button>
  `);

  document.getElementById('modal-cancel')!.addEventListener('click', closeModal);
  document.getElementById('modal-submit')!.addEventListener('click', async () => {
    const registration = (document.getElementById('v-registration') as HTMLInputElement).value.trim();
    const make = (document.getElementById('v-make') as HTMLInputElement).value.trim();
    const model = (document.getElementById('v-model') as HTMLInputElement).value.trim();
    const odometer = parseInt((document.getElementById('v-odometer') as HTMLInputElement).value);
    const dateIntervalDays = parseInt((document.getElementById('v-interval-days') as HTMLInputElement).value);
    const mileageInterval = parseInt((document.getElementById('v-interval-km') as HTMLInputElement).value);

    if (!registration || !make || !model || isNaN(odometer) || isNaN(dateIntervalDays) || isNaN(mileageInterval)) {
      toastError('Validation', 'Please fill in all fields.');
      return;
    }

    try {
      await vehicleAPI.create({ registration, make, model, odometer, dateIntervalDays, mileageInterval });
      closeModal();
      toastSuccess('Vehicle added', `${make} ${model} (${registration})`);
      await renderVehiclesPage(pageContainer);
    } catch {
      toastError('Failed', 'Could not create vehicle.');
    }
  });
}

function showEditVehicleModal(vehicle: Vehicle, pageContainer: HTMLElement): void {
  openModal('Edit Vehicle', `
    <form id="edit-vehicle-form">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="e-registration">Registration</label>
          <input type="text" id="e-registration" class="form-input" value="${vehicle.registration}" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="e-odometer">Odometer (km)</label>
          <input type="number" id="e-odometer" class="form-input" value="${vehicle.odometer}" required min="0" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="e-make">Make</label>
          <input type="text" id="e-make" class="form-input" value="${vehicle.make}" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="e-model">Model</label>
          <input type="text" id="e-model" class="form-input" value="${vehicle.model}" required />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="e-interval-days">Service Interval (days)</label>
          <input type="number" id="e-interval-days" class="form-input" value="${vehicle.dateIntervalDays}" required min="1" />
        </div>
        <div class="form-group">
          <label class="form-label" for="e-interval-km">Mileage Interval (km)</label>
          <input type="number" id="e-interval-km" class="form-input" value="${vehicle.mileageInterval}" required min="1" />
        </div>
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn-primary" id="modal-submit">Save Changes</button>
  `);

  document.getElementById('modal-cancel')!.addEventListener('click', closeModal);
  document.getElementById('modal-submit')!.addEventListener('click', async () => {
    const data = {
      registration: (document.getElementById('e-registration') as HTMLInputElement).value.trim(),
      make: (document.getElementById('e-make') as HTMLInputElement).value.trim(),
      model: (document.getElementById('e-model') as HTMLInputElement).value.trim(),
      odometer: (document.getElementById('e-odometer') as HTMLInputElement).value,
      dateIntervalDays: (document.getElementById('e-interval-days') as HTMLInputElement).value,
      mileageInterval: (document.getElementById('e-interval-km') as HTMLInputElement).value,
    };

    try {
      await vehicleAPI.update(vehicle.id, data);
      closeModal();
      toastSuccess('Vehicle updated');
      await renderVehiclesPage(pageContainer);
    } catch {
      toastError('Failed', 'Could not update vehicle.');
    }
  });
}

function showBulkUploadModal(pageContainer: HTMLElement): void {
  openModal('Bulk Odometer Update', `
    <p style="color: var(--text-secondary); font-size: var(--font-sm); margin-bottom: var(--space-4);">
      Upload a CSV file or paste CSV data with <code>registration,odometer</code> columns.
    </p>
    <div class="form-group" style="margin-bottom: var(--space-3);">
      <label class="form-label" for="csv-file">Choose CSV File</label>
      <input type="file" id="csv-file" accept=".csv,text/csv" class="form-input" style="padding: 6px;" />
    </div>
    <div class="form-group">
      <label class="form-label" for="csv-data">Or Paste CSV Data</label>
      <textarea id="csv-data" class="form-textarea" rows="4" placeholder="registration,odometer&#10;ABC-1234,55000&#10;XYZ-5678,62000"></textarea>
    </div>
    <div id="bulk-results" style="display:none; max-height: 250px; overflow-y: auto; margin-top: var(--space-3);"></div>
  `, `
    <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn-primary" id="modal-submit">Upload CSV</button>
  `);

  document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
  const submitBtn = document.getElementById('modal-submit') as HTMLButtonElement | null;

  submitBtn?.addEventListener('click', async () => {
    const fileInput = document.getElementById('csv-file') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    const textData = (document.getElementById('csv-data') as HTMLTextAreaElement | null)?.value.trim();

    if (!file && !textData) {
      toastError('Validation', 'Please select a CSV file or enter CSV data.');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Uploading...';
    }

    try {
      let res;
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        res = await vehicleAPI.bulkOdometer(formData);
      } else {
        res = await vehicleAPI.bulkOdometer(textData!);
      }

      const report = (res.data?.report || []) as Array<{
        rowNumber: number;
        vehicleIdentifier: string;
        inputOdometer: number | string;
        status: 'SUCCESS' | 'REJECTED';
        success: boolean;
        reason?: string;
      }>;

      const successCount = report.filter((r) => r.status === 'SUCCESS' || r.success).length;
      const failCount = report.filter((r) => r.status === 'REJECTED' || !r.success).length;

      const resultsEl = document.getElementById('bulk-results');
      if (resultsEl) {
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = `
          <div style="padding: var(--space-3); background: var(--bg-glass); border-radius: var(--radius-md); border: 1px solid var(--border-color);">
            <p style="margin-bottom: var(--space-2); font-weight: var(--weight-medium);">
              <strong>${successCount}</strong> updated, <strong>${failCount}</strong> rejected (${report.length} total rows)
            </p>
            <table class="data-table" style="font-size: var(--font-xs); width: 100%;">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Vehicle</th>
                  <th>Input</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                ${report.map((r) => `
                  <tr>
                    <td>${r.rowNumber}</td>
                    <td><strong>${r.vehicleIdentifier}</strong></td>
                    <td>${r.inputOdometer}</td>
                    <td>
                      ${r.status === 'SUCCESS' || r.success
                        ? '<span class="badge badge-completed">SUCCESS</span>'
                        : '<span class="badge badge-overdue">REJECTED</span>'}
                    </td>
                    <td style="color: ${r.status === 'SUCCESS' || r.success ? 'var(--text-secondary)' : 'var(--error)'};">
                      ${r.reason || 'Odometer updated successfully'}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      }

      if (successCount > 0) {
        toastSuccess('Bulk update', `${successCount} odometers updated.`);
        await renderVehiclesPage(pageContainer);
      }
    } catch (err: any) {
      const axErr = err as { response?: { data?: { error?: string } } };
      toastError('Upload failed', axErr.response?.data?.error || 'Could not process bulk update.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Upload CSV';
      }
    }
  });
}
