# Fleet Maintenance System Architecture Guide

This document provides a comprehensive technical overview of the architecture, component boundaries, domain logic, and data flow of the Fleet Maintenance System.

---

## 1. System Topology & Component Layout

```
+-------------------------------------------------------------------------+
|                              Frontend Layer                             |
|  - Vanilla TypeScript Single Page Application (SPA)                     |
|  - Custom CSS Design System (Dark mode, glassmorphism, responsive)       |
|  - Modular pages: Login, Dashboard, Vehicles, Services, Alerts          |
|  - Axios client with credentials & error interception                   |
+------------------------------------+------------------------------------+
                                     | HTTP / REST (JSON & Multipart)
                                     v
+-------------------------------------------------------------------------+
|                              Backend Layer                              |
|  - Node.js & Express 5 REST API                                         |
|  - Authentication & RBAC Middleware (`requireAuth`, `requireManager`)    |
|  - Router Layer (`/auth`, `/vehicles`, `/services`, `/alerts`, `/dash`) |
|  - Server-Side Scoping Engine (Strict Technician Query Isolation)       |
|                                                                         |
|  [ Pure Domain Logic Layer ]                                            |
|    • maintenance.ts : Pure mathematical thresholds & due evaluation     |
|    • lifecycle.ts   : Finite State Machine transition rules & guards    |
|    • audit.ts       : Standardized audit event builders                 |
|                                                                         |
|  [ Transactional Service Layer ]                                        |
|    • serviceLifecycle.ts : Atomic transactions (status, vehicle, audit) |
|    • CSV Processing Engine : Atomic per-row stream ingestion            |
+------------------------------------+------------------------------------+
                                     | Prisma ORM 7 (PostgreSQL Adapter)
                                     v
+-------------------------------------------------------------------------+
|                             Database Layer                              |
|  - PostgreSQL Database Engine                                           |
|  - Tables: User, Vehicle, ServiceRecord, TechnicianAssignment, AuditLog |
|  - Functional Indexes on query patterns, status, and foreign keys       |
+-------------------------------------------------------------------------+
```

---

## 2. Authentication & Role-Based Access Control (RBAC)

Authentication is handled statelessly using signed JSON Web Tokens (JWT) containing `{ id: string, role: Role }`. Tokens are verified on every protected route via `requireAuth` middleware.

### User Roles
The application defines two distinct roles via the `Role` enum:
1. `FLEET_MANAGER`: Full administrative authority.
2. `TECHNICIAN`: Restricted operational role.

### Permission Matrix

| Capability | Fleet Manager | Technician | Enforced At |
| :--- | :---: | :---: | :--- |
| View Fleet Dashboard | Fleet-wide totals | Assigned services only | `GET /api/dashboard` handler |
| List Vehicles | Yes (fleet-wide) | No (HTTP 403) | `requireFleetManager` |
| Create Vehicle | Yes | No (HTTP 403) | `requireFleetManager` |
| Trigger Status Evaluation | Yes | No (HTTP 403) | `requireFleetManager` |
| Search Service Records | Fleet-wide + filter by any tech | Assigned records only | Server-side query rewrite |
| Create Service Record | Yes (`DUE` status) | No (HTTP 403) | `requireFleetManager` |
| Book Service (`DUE` $\to$ `BOOKED`) | Yes (date + tech required) | No (HTTP 403) | `assertTransitionAuthorized` |
| Start Work (`BOOKED` $\to$ `IN_SERVICE`) | Yes | Assigned tech only | `assertTransitionAuthorized` |
| Complete Work (`IN_SERVICE` $\to$ `COMPLETED`) | Yes | Assigned tech only | `assertTransitionAuthorized` |
| Assign/Unassign Technicians | Yes | No (HTTP 403) | `requireFleetManager` |
| View Overdue Alerts | Fleet-wide | Assigned records only | Server-side query rewrite |
| Dismiss Overdue Alert | Yes | No (HTTP 403) | `requireFleetManager` |
| Import Odometer CSV | Yes | No (HTTP 403) | `requireFleetManager` |
| Export Service History CSV | Yes | Yes (scoped to assigned) | `services.ts` handler |

---

## 3. Server-Side Technician Scoping

To guarantee that technicians cannot access data outside their assigned tasks, the backend **enforces scoping at the database query level**.

When a user with `role === 'TECHNICIAN'` calls any listing, search, alerts, or dashboard endpoint:
* The server automatically injects `assignments: { some: { userId: caller.id } }` into the Prisma query `where` clause.
* If a technician passes query parameters like `?technicianId=<other-tech-id>` in an attempt to inspect another technician's workload, the parameter is ignored.
* Fleet-level vehicle queries (`GET /api/vehicles`) reject technicians immediately with `HTTP 403 Forbidden`.

---

## 4. Maintenance Domain Engine

All maintenance interval and overdue calculations are housed in a decoupled, pure functional module ([`backend/src/domain/maintenance.ts`](file:///c:/Users/energ/Desktop/Busy_Dummy/backend/src/domain/maintenance.ts)). It has no dependencies on Express, Prisma, or external APIs, making it completely deterministic and unit-testable.

### Threshold Calculations
1. **Date Threshold**:
   $$\text{dateThreshold} = \text{lastServiceDate} + (\text{dateIntervalDays} \times 86,400,000 \text{ ms})$$
2. **Mileage Threshold**:
   $$\text{mileageThreshold} = \text{lastServiceMileage} + \text{mileageInterval}$$

### Due Evaluation Rules (`evaluateServiceDue`)
* If $\text{odometer} \ge \text{mileageThreshold}$ OR $\text{evaluationTime} \ge \text{dateThreshold}$, the vehicle is **DUE**.
* **Trigger Attribution & Canonical Due Date**:
  * If both thresholds are reached: Trigger is `DATE`, canonical `dueDate` is `dateThreshold` (earlier historical deadline).
  * If only mileage threshold is reached: Trigger is `MILEAGE`, canonical `dueDate` is `evaluationTime`.
  * If only date threshold is reached: Trigger is `DATE`, canonical `dueDate` is `dateThreshold`.

### Overdue Condition (`isServiceOverdue`)
A service is overdue if and only if:
1. Status is `DUE` or `BOOKED`.
2. `dueDate` is not null.
3. $\text{evaluationTime} > \text{dueDate} + (\text{gracePeriodDays} \times 86,400,000 \text{ ms})$.
* Exactly on the boundary ($\text{evaluationTime} == \text{dueDate} + \text{gracePeriod}$), the service is **not** overdue.

---

## 5. Strict Service Lifecycle & State Machine

The service lifecycle is governed by a strict Finite State Machine ([`backend/src/domain/lifecycle.ts`](file:///c:/Users/energ/Desktop/Busy_Dummy/backend/src/domain/lifecycle.ts)):

```
       [Vehicle Due / Created]
                  │
                  ▼
              ┌───────┐
              │  DUE  │ ◄─────── (Created by Manager or Auto-Eval)
              └───┬───┘
                  │
                  │ Manager Books (requires dateScheduled + assigned technician)
                  ▼
             ┌────────┐
             │ BOOKED │
             └───┬────┘
                 │
                 │ Assigned Tech or Manager Starts Work
                 ▼
          ┌────────────┐
          │ IN_SERVICE │
          └──────┬─────┘
                 │
                 │ Assigned Tech or Manager Completes (requires completedOdometer >= current)
                 ▼
           ┌───────────┐
           │ COMPLETED │ ───────► [Baseline Reset & Cycle Increment]
           └───────────┘
```

Any attempt to execute an illegal transition (e.g. `DUE` $\to$ `IN_SERVICE`, `BOOKED` $\to$ `COMPLETED`, or backwards transitions) is blocked by `assertValidTransition` and returns `HTTP 400 Bad Request`.

---

## 6. Transaction Boundaries & Audit Logging

Every state transition and data mutation executes inside an atomic Prisma transaction (`prisma.$transaction`) in [`backend/src/services/serviceLifecycle.ts`](file:///c:/Users/energ/Desktop/Busy_Dummy/backend/src/services/serviceLifecycle.ts):

### Completion Transaction Example (`IN_SERVICE` $\to$ `COMPLETED`):
Within a single transaction:
1. Update `ServiceRecord`: status set to `COMPLETED`, `dateCompleted` set to now, `completedOdometer` recorded.
2. Update `Vehicle`:
   * `odometer = completedOdometer`
   * `lastServiceDate = dateCompleted`
   * `lastServiceMileage = completedOdometer`
   * `serviceCycle = serviceCycle + 1`
3. Create `AuditLog`: Action `'SERVICE_COMPLETED'`, recording user ID, odometer, and baseline shifts.

If any step fails (e.g. database disconnect, odometer constraint violation), the entire transaction rolls back cleanly, leaving zero partial records or orphan audit logs.

---

## 7. Derived State at Query Time (Why No Background Jobs?)

A core design principle of this repository is **dynamic query-time derivation**:
1. **Overdue Status**:
   * *Why not a database column?* A service status column like `OVERDUE` requires continuous polling, cron jobs, or database triggers to update records as time passes. If the worker crashes, data becomes stale.
   * *How it works*: Overdue is derived at query time by comparing `dueDate` against `now` and `gracePeriodDays`. It is always 100% accurate at the moment of evaluation.
2. **Cycle-Aware Alert Dismissal**:
   * *Why not an `isDismissed` boolean?* A boolean flag would permanently mute alerts on that vehicle or require a cron job to reset when the service completes.
   * *How it works*: Dismissal sets `Vehicle.dismissedAlertCycle = Vehicle.serviceCycle`. Alerts are visible when `isOverdue === true && dismissedAlertCycle !== serviceCycle`. When the service completes and `serviceCycle` increments from $N \to N+1$, the next cycle's overdue alert automatically becomes visible without any cleanup scripts.

---

## 8. CSV Ingestion Engine

The CSV upload subsystem ([`backend/src/routes/vehicles.ts`](file:///c:/Users/energ/Desktop/Busy_Dummy/backend/src/routes/vehicles.ts)) accepts multipart/form-data containing vehicle odometer updates:
* **Stream Parsing**: Uses `csv-parse/sync` with header normalization and comment handling.
* **Per-Row Isolation**: Each row is processed in its own independent database transaction. Malformed rows, unknown vehicle registrations, or negative odometers are rejected with specific error messages, while valid rows commit successfully.
* **Concurrency Protection**: Inside each row transaction, the vehicle's current odometer is re-read from PostgreSQL to verify `newOdometer >= currentDatabaseOdometer`.
* **Sequential In-File Deduplication**: When multiple rows update the same vehicle in a single file, later rows are evaluated against the highest odometer value established by preceding rows in that file.

---

## 9. Dashboard Architecture

The dashboard endpoint (`GET /api/dashboard`) aggregates fleet operations entirely on the server using Prisma count and group-by primitives:
* `vehiclesDue`: Computed by running `evaluateServiceDue()` on active vehicles.
* `vehiclesInService`: Database `count` of distinct vehicles with active `IN_SERVICE` records.
* `completedThisWeek`: Database `count` of completions between Monday 00:00:00 and Sunday 23:59:59.
* `overdue`: Derived active overdue alerts matching cycle visibility rules.
* `statusBreakdown`: Server-side `groupBy({ by: ['status'] })`.
* `technicianBreakdown`: Assigned service metrics per technician (strictly filtered to the caller if a technician).
* `completedLast8Weeks`: 8 partitioned calendar weeks with completions bucketed into their exact chronological week.
* **Frontend Visualization**: Rendered via pure SVG bar chart, eliminating bulky charting libraries while preserving theme responsiveness.
