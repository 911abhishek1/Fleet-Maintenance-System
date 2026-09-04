# Fleet Maintenance Implementation Roadmap & History

This document outlines the chronological implementation plan, verified commit history, verification procedures, and architectural tradeoffs executed across all milestones of the Fleet Maintenance System.

---

## 1. Verified Commit History & Milestones

All work was completed incrementally across 8 sequential, self-contained milestones following strict test-driven development (TDD):

```
8f96e6b (Initial Commit)
   │
   ▼
34a019c (Milestone 1: Technician Assignment Workflow)
   │
   ▼
a070508 (Milestone 2: Maintenance Cycle Tracking Schema)
   │
   ▼
afdb595 (Milestone 3: Maintenance Domain Rules)
   │
   ▼
ee4b7a2 (Milestone 4: Transactional Service Lifecycle)
   │
   ▼
fd9a595 (Milestone 5: Server-Side Querying & Pagination)
   │
   ▼
3cb83c9 (Milestone 6: Multipart CSV Import/Export)
   │
   ▼
0a3b7a7 (Milestone 7: Overdue Service Alerts & Dismissal)
   │
   ▼
7efbc84 (Milestone 8: Fleet Maintenance Dashboard)
   │
   ▼
f2f7053 -> 6448efd (Milestone 9: Quality Assurance & Workflow Hardening)
   │
   ▼
[Working Tree] (Milestone 10: Vehicle Inspection Checklists - Stretch Feature)
```

---

## 2. Milestone Breakdown & Phase Verification

### Milestone 1: Technician Assignment Workflow
* **Commit**: `34a019c` — *feat: improve technician assignment workflow*
* **Scope**:
  * Added atomic endpoints `POST /api/services/:id/assignments` and `DELETE /api/services/:id/assignments/:technicianId`.
  * Enforced Fleet Manager authorization and technician role verification.
  * Wrapped assignment mutations and audit log events in atomic Prisma transactions.
* **Verification**: Node.js integration tests verifying atomicity on rollback and technician role guards.

### Milestone 2: Maintenance Cycle Tracking Schema
* **Commit**: `a070508` — *feat: add maintenance cycle tracking schema*
* **Scope**:
  * Created Prisma migration `20260903180500_add_maintenance_cycle_tracking`.
  * Added `serviceCycle`, `dismissedAlertCycle`, `lastServiceDate`, `lastServiceMileage`, `dateIntervalDays`, and `mileageInterval` to `Vehicle`.
  * Added `cycle` to `ServiceRecord`.
  * Executed deterministic backfill initializing baseline maintenance cycles for existing vehicles.
* **Verification**: Verified database constraints and backfill data consistency in PostgreSQL.

### Milestone 3: Pure Maintenance Domain Rules
* **Commit**: `afdb595` — *feat: add maintenance calculation domain rules*
* **Scope**:
  * Implemented pure functions `calculateDateThreshold()`, `calculateMileageThreshold()`, `evaluateServiceDue()`, and `isServiceOverdue()` in `backend/src/domain/maintenance.ts`.
  * Enforced date interval and mileage interval validation (> 0).
  * Built deterministic trigger selection (`MILEAGE`, `DATE`, or earlier historical date when both thresholds are reached).
* **Verification**: 20 unit tests in `backend/src/domain/maintenance.test.ts` covering boundary conditions and zero-grace-period evaluations.

### Milestone 4: Transactional Service Lifecycle
* **Commit**: `ee4b7a2` — *feat: implement transactional service lifecycle*
* **Scope**:
  * Implemented strict four-state Finite State Machine (`DUE` $\to$ `BOOKED` $\to$ `IN_SERVICE` $\to$ `COMPLETED`) in `backend/src/domain/lifecycle.ts`.
  * Refactored `backend/src/services/serviceLifecycle.ts` to execute status updates inside atomic transactions.
  * Enforced manager-only booking with mandatory appointment date and assigned technician.
  * Handled service completion: updates vehicle odometer, resets baseline mileage and service date, and increments `serviceCycle`.
  * Corrected manual manager service creation: created services always start in `DUE` status with canonical due date set to current creation time.
* **Verification**: Integration tests in `backend/src/services/serviceLifecycle.test.ts` (full lifecycle progression, baseline shifts, and rollback safety).

### Milestone 5: Server-Side Querying & Pagination
* **Commit**: `fd9a595` — *feat: add server side querying and pagination*
* **Scope**:
  * Refactored `GET /api/services/search` supporting description search, filter combinations (`vehicleId`, `status`, `technicianId`), sorting, and pagination metadata (`page`, `limit`, `total`, `totalPages`).
  * Enforced hardcoded server-side query scoping for technicians (`assignments: { some: { userId } }`).
  * Added functional indexes in migration `20260903193529_add_query_indexes`.
  * Refactored `GET /api/vehicles` for server-side search and pagination.
* **Verification**: 23 integration tests in `backend/src/routes/querying.test.ts`.

### Milestone 6: Robust Multipart CSV Import & Export
* **Commit**: `3cb83c9` — *feat: add robust csv import and export*
* **Scope**:
  * Integrated `multer` memory storage and `csv-parse/sync` for `POST /api/vehicles/import-csv`.
  * Implemented row-by-row isolation: invalid rows return itemized errors without aborting valid rows.
  * Re-read database odometer inside each row transaction (`newOdometer >= currentDatabaseOdometer`) to protect against concurrent modifications.
  * Implemented sequential in-file duplicate row tracking.
  * Refactored `GET /api/services/export-csv` with RFC 4180 compliant escaping.
* **Verification**: 15 integration tests in `backend/src/routes/csv.test.ts`.

### Milestone 7: Overdue Service Alerts & Dismissal
* **Commit**: `0a3b7a7` — *feat: add overdue service alerts*
* **Scope**:
  * Created `backend/src/config.ts` with safe parsing rule for `OVERDUE_GRACE_PERIOD_DAYS` (accepts finite values $\ge 0$, including `0`, falls back to 7).
  * Implemented `GET /api/alerts` using query-time `isServiceOverdue()` evaluation and cycle filtering (`dismissedAlertCycle !== serviceCycle`).
  * Implemented `POST /api/alerts/:serviceRecordId/dismiss` setting `Vehicle.dismissedAlertCycle = Vehicle.serviceCycle` in an atomic transaction with `ALERT_DISMISSED` audit logging.
  * Added Alerts page and live nav badge in frontend.
* **Verification**: 18 integration tests in `backend/src/routes/alerts.test.ts` and manual verification of the Cycle 1 $\to$ Dismiss $\to$ Complete $\to$ Cycle 2 re-alerting scenario.

### Milestone 8: Fleet Maintenance Dashboard
* **Commit**: `7efbc84` — *feat: add fleet maintenance dashboard*
* **Scope**:
  * Implemented `GET /api/dashboard` computing 4 KPI cards (`vehiclesDue`, `vehiclesInService`, `completedThisWeek`, `overdue`), status breakdown, technician breakdown, and 8-week completion chart buckets.
  * Enforced role scoping: technicians receive strictly their own assigned metrics.
  * Updated frontend dashboard with custom SVG bar chart, progress bar breakdown, and KPI cards.
* **Verification**: 10 integration tests in `backend/src/routes/dashboard.test.ts` and real HTTP response verification.

### Milestone 9: Quality Assurance & Workflow Hardening
* **Commits**: `f2f7053`, `f0ca8ab`, `6448efd`
* **Scope**:
  * Added Due Date column to frontend Services table.
  * Added booking date prompt modal prior to `DUE -> BOOKED` transition.
  * Fixed numeric odometer parsing for service completion.
  * Hardened technician assignment validation (reject assigning Fleet Managers).
  * Restricted service creation to Fleet Managers and prevented IDOR on single-service access.
* **Verification**: 14 workflow integration tests in `backend/src/routes/servicesWorkflow.test.ts`.

### Milestone 10: Vehicle Inspection Checklists (Stretch Feature)
* **Scope**:
  * Added `ChecklistItemResult` enum (`PENDING`, `PASS`, `FAIL`, `NOT_APPLICABLE`) and `InspectionChecklistItem` model with Prisma migration `20260904113800_add_inspection_checklists`.
  * Built dedicated router `backend/src/routes/checklist.ts` mounted under `/api/services/:serviceId/checklist`.
  * Enforced strict server-side RBAC: Manager can define items and administrative overrides; assigned Technicians can update results/notes on assigned services; unassigned Technicians get `HTTP 403 Forbidden`.
  * Enforced immutability on completed services: mutations rejected with `HTTP 400`.
  * Ensured audit decoupling: `AuditLog` has no foreign key to checklist items, preserving audit history indefinitely even upon item deletion.
  * Built frontend inspection checklist modal with progress bars, color-coded status badges, interactive result toggles, and technician notes.
* **Verification**: 14 integration tests in `backend/src/routes/checklist.test.ts` (151 total passing backend tests), plus complete 15-step real HTTP E2E scenario run.

---

## 3. Remaining Work / Production Readiness (TODOs)

The placement assignment requirements and chosen stretch feature are fully satisfied. The following enhancements represent future production readiness tasks:
1. **[ ] Deployment & CI/CD Pipeline**: Setup automated GitHub Actions pipeline to run tests, build Vite assets, and deploy backend to a hosted container (e.g. AWS ECS, Render, or Fly.io).
2. **[ ] Real-time WebSocket Updates**: Push alert badge updates and dashboard metrics over WebSockets to eliminate manual page reloads when maintenance status changes.
3. **[ ] Email/SMS Alert Notifications**: Trigger email notifications to fleet managers when high-priority vehicles exceed grace periods.
4. **[ ] Multi-Organization Fleet Partitioning**: Add tenant isolation for third-party fleet operators managing distinct vehicle organizations.
