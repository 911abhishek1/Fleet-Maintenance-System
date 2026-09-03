# Fleet Maintenance Assignment Submission

**Candidate Submission Document**  
**Repository**: Fleet Maintenance System (`FleetPro`)  
**Deployment URL**: `TODO: Not yet deployed (running locally at http://localhost:5173)`

---

## 1. Project Overview

The Fleet Maintenance System is an enterprise full-stack platform designed to automate and enforce vehicle maintenance operations. The application guarantees vehicle reliability by calculating preventive maintenance needs based on elapsed time and vehicle mileage, enforcing a strict four-stage transactional service lifecycle, protecting access via server-side Role-Based Access Control (RBAC), and delivering actionable fleet health metrics on a real-time dashboard.

---

## 2. Core Implemented Features

1. **Role-Based Access Control (RBAC) & Scoping**:
   * **Fleet Manager**: Full administrative access over vehicles, service scheduling, technician assignments, CSV operations, and alert dismissals.
   * **Technician**: Access strictly restricted to assigned service records. Technicians cannot list all fleet vehicles, cannot book services, cannot dismiss alerts, and cannot view or tamper with other technicians' tasks.
2. **Maintenance Domain Calculation Engine**:
   * Pure functional domain layer evaluating maintenance thresholds:
     $$\text{Date Threshold} = \text{lastServiceDate} + \text{dateIntervalDays}$$
     $$\text{Mileage Threshold} = \text{lastServiceMileage} + \text{mileageInterval}$$
   * Deterministic trigger attribution (`MILEAGE`, `DATE`, or earlier historical date when both thresholds are exceeded).
   * Canonical `dueDate` calculation.
3. **Strict Four-State Transactional Service Lifecycle**:
   * Lifecycle states: `DUE` $\to$ `BOOKED` $\to$ `IN_SERVICE` $\to$ `COMPLETED`.
   * Invalid transitions rejected with HTTP 400.
   * Booking requires scheduled date and at least one assigned technician.
   * Service completion executes inside an atomic database transaction: updates service record, updates vehicle odometer, resets vehicle baseline mileage and service date, and increments `Vehicle.serviceCycle` from $N \to N+1$.
4. **Server-Side Querying, Filtering & Pagination**:
   * Endpoint `GET /api/services/search` supports text search on description, filtering by `vehicleId`, `status`, and `technicianId`, and sorting with pagination metadata (`total`, `page`, `limit`, `totalPages`).
   * Technicians querying `/api/services/search` have `assignments: { some: { userId } }` hardcoded on the server.
   * Endpoint `GET /api/vehicles` supports pagination, search by registration/make/model, and archived filtering.
5. **Atomic Multipart CSV Odometer Import & RFC 4180 Export**:
   * Fleet Managers can upload `.csv` files via multipart/form-data.
   * Streaming RFC-compliant CSV parser (`csv-parse/sync`).
   * Row-by-row isolation: invalid rows are reported with itemized failure reasons without aborting valid rows.
   * Re-reads database odometer inside each row transaction (`newOdometer >= currentDatabaseOdometer`) to prevent concurrency corruption.
   * Service history export formatted with RFC 4180 escaping (`csv-stringify/sync`).
6. **Cycle-Aware Overdue Service Alerts**:
   * Overdue status is derived at query time based on `dueDate + gracePeriodDays` (default 7 days, configurable via `OVERDUE_GRACE_PERIOD_DAYS`, safely parsing `0` as immediate overdue).
   * Managers can dismiss an overdue alert for the current cycle: sets `Vehicle.dismissedAlertCycle = Vehicle.serviceCycle` in an atomic transaction with an `ALERT_DISMISSED` audit event.
   * When a service completes and cycle advances to $N+1$, the next maintenance cycle re-surfaces an alert automatically without background jobs or cleanup scripts.
7. **Fleet Maintenance Dashboard**:
   * Endpoint `GET /api/dashboard` computing server-side metrics:
     * `vehiclesDue`: Count of active vehicles whose maintenance is due via domain evaluation.
     * `vehiclesInService`: Count of active vehicles with an active `IN_SERVICE` record.
     * `completedThisWeek`: Service completions during current ISO calendar week (Monday 00:00 to Sunday 23:59).
     * `overdue`: Current active overdue alerts.
     * `statusBreakdown`: Grouped counts across the 4 statuses (`DUE`, `BOOKED`, `IN_SERVICE`, `COMPLETED`).
     * `technicianBreakdown`: Assigned workload per technician. Technicians only receive their own metrics.
     * `completedLast8Weeks`: Weekly completed service counts across the latest 8 calendar weeks, preserving zero-count weeks.
   * Lightweight responsive SVG bar chart rendered on the frontend with zero third-party charting libraries.

---

## 3. Architecture Summary

```
                      ┌─────────────────────────────────────────┐
                      │          Vanilla TypeScript SPA         │
                      │         (Vite, Pure CSS, SVG Chart)     │
                      └────────────────────┬────────────────────┘
                                           │ HTTP / JSON / Cookies
                      ┌────────────────────▼────────────────────┐
                      │          Express 5 REST API             │
                      ├─────────────────────────────────────────┤
                      │  Middleware: requireAuth, requireManager│
                      │  Scoping: Technician Query Isolation    │
                      ├─────────────────────────────────────────┤
                      │  Domain Engine:                         │
                      │  • maintenance.ts (pure math)           │
                      │  • lifecycle.ts (FSM rules & guards)    │
                      │  • audit.ts (atomic event logger)       │
                      ├─────────────────────────────────────────┤
                      │  Services: serviceLifecycle.ts          │
                      │  (Transactions: status + vehicle + log) │
                      └────────────────────┬────────────────────┘
                                           │ Prisma Client (v7)
                      ┌────────────────────▼────────────────────┐
                      │          PostgreSQL Database            │
                      │  • Vehicles (baselines, cycle tracking) │
                      │  • ServiceRecords (status, cycle, due)  │
                      │  • TechnicianAssignments (composite PK) │
                      │  • AuditLogs (immutable event history)  │
                      └─────────────────────────────────────────┘
```

---

## 4. Setup & Run Instructions

### Prerequisites
* Node.js v20.x or v22.x
* PostgreSQL instance running locally or remotely

### Backend Setup
1. Navigate to backend directory and install dependencies:
   ```bash
   cd backend
   npm install
   ```
2. Create `backend/.env`:
   ```env
   DATABASE_URL="postgresql://postgres:password@localhost:5432/fleet_db?schema=public"
   JWT_SECRET="development_secret_key"
   PORT=5000
   FRONTEND_URL="http://localhost:5173"
   OVERDUE_GRACE_PERIOD_DAYS=7
   ```
3. Run database migrations and generate Prisma client:
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```
4. Start backend server:
   ```bash
   npm run dev
   # Runs on http://localhost:5000
   ```

### Frontend Setup
1. Navigate to frontend directory and install dependencies:
   ```bash
   cd ../frontend
   npm install
   ```
2. Start frontend dev server:
   ```bash
   npm run dev
   # Runs on http://localhost:5173
   ```

---

## 5. Required Environment Variables

| Variable | Scope | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Backend | PostgreSQL connection string | `postgresql://postgres:password@localhost:5432/fleet_db?schema=public` |
| `JWT_SECRET` | Backend | Secret key used for signing session tokens | `development_secret_key` |
| `PORT` | Backend | HTTP port for Express backend | `5000` |
| `FRONTEND_URL` | Backend | Allowed CORS origin | `http://localhost:5173` |
| `OVERDUE_GRACE_PERIOD_DAYS` | Backend | Days after `dueDate` before service is overdue | `7` (accepts `0` as immediate overdue) |

---

## 6. Demo Credentials & Account Provisioning

The application enforces strict server-side Role-Based Access Control (RBAC) between **Fleet Managers** (fleet-wide administration, scheduling, alert dismissals, CSV imports) and **Technicians** (strictly scoped to assigned service records, zero fleet-wide vehicle access).

### Evaluation Account Provisioning
Because this repository does not include a committed static database seed script with guaranteed plaintext passwords, the recommended and most reliable way to evaluate both roles in any environment is through the built-in registration workflow:

1. **Self-Registration for Evaluation (`/login` -> Register tab)**:
   * **Fleet Manager Persona**: Register any email (e.g. `manager@fleet.com`) with a password of your choice and select **Fleet Manager** to test administrative capabilities (vehicle creation, service booking, CSV upload, overdue alert dismissal, and fleet-wide dashboard metrics).
   * **Technician Persona**: Register a second email (e.g. `tech@fleet.com`) and select **Technician** to verify operational scoping and access restrictions.

2. **Existing Development Database Notice**:
   * If connecting to an existing pre-populated development database, user records such as `testadmin@fleet.com` (Fleet Manager) and `divyani@gmail.com` (Technician) may already exist. However, because passwords are stored exclusively as bcrypt hashes and cannot be verified from code, registering fresh accounts with known credentials on `/login` is recommended.

> [!NOTE]
> **RBAC Boundary & Security Context**:
> Open self-registration with client-selectable roles is a boilerplate testing convenience provided for evaluation purposes; it is not intended as an enterprise-grade user provisioning workflow. Crucially, **all post-authentication authorization is strictly enforced on the server**:
> * Once authenticated with the `TECHNICIAN` role, all queries are automatically filtered to records where `assignments: { some: { userId } }`.
> * Technicians cannot list fleet vehicles (`GET /api/vehicles` returns `403 Forbidden`).
> * Any client-side attempt to manipulate query parameters (such as `?technicianId=`) is ignored by the server.

---

## 7. Test Verification

The test suite consists of **123 automated tests across 26 test suites**, executing through Node.js native test runner:

```bash
cd backend
npm test
```

### Verified Test Suites:
1. `backend/src/domain/lifecycle.test.ts` (24 tests) — State transitions, role authorization, and transition input validation.
2. `backend/src/domain/maintenance.test.ts` (20 tests) — Threshold calculation, interval validation, trigger selection, and overdue boundary checks.
3. `backend/src/services/serviceLifecycle.test.ts` (13 tests) — Transactional state transitions, baseline resets, odometer validation, and atomic audit logs.
4. `backend/src/routes/querying.test.ts` (23 tests) — Server-side searching, filter combinations, pagination boundaries, and technician query scoping.
5. `backend/src/routes/csv.test.ts` (15 tests) — Multipart uploads, row-by-row isolation, duplicate handling, and RFC 4180 CSV escaping.
6. `backend/src/routes/alerts.test.ts` (18 tests) — Query-time overdue derivation, manager-only dismissal, cycle scoping, and next-cycle re-alerting.
7. `backend/src/routes/dashboard.test.ts` (10 tests) — Fleet-wide vs. technician-scoped KPI metrics, calendar week boundaries, and 8-week completion buckets.

---

## 8. Limitations & Engineering Tradeoffs

1. **Query-Time Derivation vs. Cron Jobs**:
   * *Tradeoff*: Overdue states and maintenance due conditions are computed dynamically on query rather than via asynchronous cron workers or background daemons.
   * *Rationale*: Avoids distributed scheduler synchronization, worker queue failure modes, and stale database state. For enterprise fleets up to tens of thousands of vehicles, query-time evaluation with database indexes provides millisecond response times.
2. **In-Memory CSV Stream Buffer**:
   * *Tradeoff*: CSV file uploads are stored in memory buffers via `multer.memoryStorage()` with a 5MB size limit.
   * *Rationale*: Avoids writing untrusted temporary files to the disk subsystem. For fleet odometer updates (typically hundreds to low thousands of rows), memory consumption is negligible (< 2MB).
3. **Responsive Inline SVG Chart vs. Chart Library**:
   * *Tradeoff*: Implemented an inline, responsive SVG bar chart instead of pulling in Chart.js or Recharts.
   * *Rationale*: Keeps frontend bundle size minimal, eliminates external dependencies, and ensures full CSS styling control under the application's dark mode design system.
4. **Single Active Service Record per Vehicle**:
   * *Tradeoff*: The evaluation engine enforces that vehicles with an active service (`status !== 'COMPLETED'`) do not generate duplicate due service records.
   * *Rationale*: Prevents workshop clutter and redundant technician assignments for vehicles already in the maintenance pipeline.

---

## 9. AI Usage Disclosure

AI assistance (Google DeepMind Antigravity) was utilized during the development of this project for pair programming, test case design, transactional lifecycle verification, and documentation preparation.

All prompts, constraints, and instructions used during development are documented transparently in [docs/ai-prompts.md](./docs/ai-prompts.md).
