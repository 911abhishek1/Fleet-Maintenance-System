# Architecture Decision Records (ADRs)

This document records the architectural and engineering decisions made during the development of the Fleet Maintenance System, explaining the context, alternatives considered, and rationale.

---

## ADR-001: Pure Maintenance Domain Calculations

* **Status**: Accepted
* **Context**: Maintenance thresholds, trigger attribution, and due dates were previously coupled to database query logic or spread across frontend view components.
* **Decision**: Extract all mathematical calculations into a pure, functional domain module (`backend/src/domain/maintenance.ts`) that accepts plain JavaScript objects and numbers.
* **Consequences**:
  * Calculations are completely deterministic and independent of database state or ORMs.
  * 100% testable via unit tests without mocking database connections.
  * Timezone-agnostic calculations operating over UTC epoch milliseconds.

---

## ADR-002: Four-State Service Lifecycle FSM

* **Status**: Accepted
* **Context**: Previously, service status updates allowed arbitrary status changes (e.g. creating services directly in `COMPLETED` status or skipping scheduling), leading to inconsistent vehicle odometers and unassigned completions.
* **Decision**: Enforce a strict Finite State Machine:
  $$\text{DUE} \longrightarrow \text{BOOKED} \longrightarrow \text{IN\_SERVICE} \longrightarrow \text{COMPLETED}$$
  All invalid transitions throw `InvalidTransitionError` and return HTTP 400.
* **Consequences**:
  * Services cannot be booked without an appointment date and at least one assigned technician.
  * Services cannot be completed without recording the final completion odometer reading ($\ge$ current vehicle odometer).
  * Backwards status transitions and arbitrary skips are completely blocked.

---

## ADR-003: Overdue as a Derived Condition (No `OVERDUE` Enum)

* **Status**: Accepted
* **Context**: Initial designs suggested adding `OVERDUE` to the `ServiceStatus` database enum.
* **Decision**: Reject `OVERDUE` as a database lifecycle status. Keep overdue strictly as a **derived condition** evaluated at query time using:
  $$\text{now} > \text{dueDate} + (\text{gracePeriodDays} \times 86,400,000 \text{ ms})$$
* **Consequences**:
  * Eliminates the need for background cron workers or daemons constantly updating rows in the database.
  * Prevents state desynchronization: a service is immediately recognized as overdue the moment grace period expires without waiting for a cron interval.
  * Keeps the lifecycle state machine clean: a service remains in `DUE` or `BOOKED` while undergoing work, even if overdue.

---

## ADR-004: Cycle-Aware Alert Dismissal vs. `ServiceAlert` Table

* **Status**: Accepted
* **Context**: When a Fleet Manager dismisses an overdue alert, that alert should be suppressed for the current maintenance cycle, but a future overdue service on the same vehicle must alert again. Adding an `isDismissed` boolean to `Vehicle` would permanently silence alerts. Creating a `ServiceAlert` table would require complex foreign keys and periodic table pruning.
* **Decision**: Utilize `Vehicle.serviceCycle` and `Vehicle.dismissedAlertCycle`. When dismissed, set `dismissedAlertCycle = serviceCycle`. An alert is visible iff:
  $$\text{isOverdue} = \text{true} \land \text{Vehicle.dismissedAlertCycle} \neq \text{Vehicle.serviceCycle}$$
* **Consequences**:
  * Dismissal applies cleanly to the active cycle without touching `ServiceRecord` or creating extra tables.
  * When a service completes, `serviceCycle` increments from $N \to N+1$. In the next cycle, `dismissedAlertCycle` ($N$) automatically no longer matches `serviceCycle` ($N+1$), immediately allowing new overdue alerts to surface.
  * Zero cron jobs or cleanup daemons required.

---

## ADR-005: Server-Enforced Technician Scoping

* **Status**: Accepted
* **Context**: Technicians must only access services assigned to them. Relying on frontend UI hiding or client-provided query parameters invites authorization bypass and privilege escalation.
* **Decision**: Hardcode technician scoping on the server inside route handlers. When `req.user.role === 'TECHNICIAN'`, the server enforces `assignments: { some: { userId: req.user.id } }` in Prisma queries, ignoring any client query parameters.
* **Consequences**:
  * Tamper-proof security: tampering with query strings (e.g. `?technicianId=all`) is completely ineffective.
  * Technicians receive zero leaked metadata regarding other technicians' workloads or unassigned fleet vehicles.

---

## ADR-006: Transactional Service Lifecycle & Audit Logging

* **Status**: Accepted
* **Context**: Moving a service from `IN_SERVICE` to `COMPLETED` requires updating the service record, updating the vehicle's odometer and baseline maintenance cycle, and generating an audit log entry. If any step fails, the system enters an inconsistent state.
* **Decision**: Wrap all status transitions and audit log generation inside atomic Prisma transactions (`prisma.$transaction`).
* **Consequences**:
  * Guarantees all-or-nothing atomicity.
  * Eliminates orphan audit records or partially updated vehicles.
  * Audit logs are generated synchronously inside the transaction, preserving chronological immutability.

---

## ADR-007: Atomic Multipart CSV Import with Row-by-Row Isolation

* **Status**: Accepted
* **Context**: Bulk odometer updates can contain hundreds of rows where some rows have typos, negative numbers, or non-existent vehicle registrations. Aborting the entire file on a single typo degrades user experience; committing all rows without validation corrupts data.
* **Decision**:
  1. Parse CSV files in memory using `multer.memoryStorage()` and `csv-parse/sync`.
  2. Process rows sequentially, executing each row in an independent database transaction.
  3. Re-read the database odometer inside each row transaction to ensure `newOdometer >= currentDatabaseOdometer`.
  4. Track duplicate rows within the uploaded file sequentially.
* **Consequences**:
  * Partial success: valid rows commit while invalid rows return itemized errors with row numbers and exact rejection reasons.
  * Concurrency protection against simultaneous updates.

---

## ADR-008: Operational Treatment of Archived Vehicles

* **Status**: Accepted
* **Context**: When vehicles are decommissioned or archived (`archived: true`), should their services appear on the operational dashboard and active alert views?
* **Decision**: Filter out archived vehicles (`vehicle: { archived: false }`) from all active operational metrics (`vehiclesDue`, `vehiclesInService`, `overdue`, `completedThisWeek`, `statusBreakdown`, `technicianBreakdown`, and `completedLast8Weeks`).
* **Consequences**:
  * Decommissioned assets do not pollute workshop capacity or trigger overdue emergency alarms.
  * Vehicle history is preserved for compliance auditing without skewing current fleet health.

---

## ADR-009: Responsive Inline SVG Bar Chart (Zero Charting Dependencies)

* **Status**: Accepted
* **Context**: The assignment required an 8-week completed service trend chart on the dashboard. Adding third-party charting libraries (e.g. Chart.js, Recharts) adds significant bundle weight and often requires complex CSS overrides to match custom dark themes.
* **Decision**: Render an inline, responsive SVG bar chart directly in TypeScript.
* **Consequences**:
  * Zero new npm dependencies added to the frontend.
  * Lightweight bundle size (< 50KB gzipped).
  * Seamless visual integration with the existing CSS design tokens and theme variables.

---

## ADR-010: Service-Scoped Inspection Checklists (Stretch Feature)

* **Status**: Accepted
* **Context**: Fleet operators require verification of mechanical checkpoints (e.g. brake pads, tire condition, fluids, lighting) during vehicle maintenance. The system needed a stretch feature to allow Fleet Managers to define checklist tasks for a service and assigned Technicians to record inspection results (`PENDING`, `PASS`, `FAIL`, `NOT_APPLICABLE`) and notes during service execution.
* **Decision**:
  1. **Minimal Schema Model**: Introduce `InspectionChecklistItem` tied via foreign key to `ServiceRecord` (`serviceRecordId`), not global to a vehicle or technician. Include `title`, `description`, `required`, `result`, `notes`, `checkedById`.
  2. **Strict RBAC & Immutability**:
     - Fleet Managers can create and delete checklist items for active services, and update results/notes as administrative overrides.
     - Assigned Technicians can view and update results and notes only for services assigned to them.
     - Unassigned Technicians are rejected with `HTTP 403 Forbidden`.
     - Once a service transitions to `COMPLETED`, all checklist mutations (POST, PUT, DELETE) are strictly blocked with `HTTP 400`, locking the inspection history permanently.
  3. **Audit Immutability & Decoupling**:
     - `AuditLog` has **no foreign key** dependency on `InspectionChecklistItem`.
     - Deleting a checklist item records `CHECKLIST_ITEM_DELETED` in the audit timeline *before* deletion, capturing the deleted item's title and previous result.
     - Deleting checklist items leaves all audit records completely intact.
  4. **Dedicated Routing**:
     - Mount endpoints cleanly under `checklist.ts` (`/api/services/:serviceId/checklist`), keeping the existing lifecycle state machine (`serviceLifecycle.ts`) clean and unpolluted.
* **Alternatives Considered**:
  * *Alternative 1: Global inspection template engine with automated duplication into services*. Rejected as severe over-engineering for a focused stretch feature.
  * *Alternative 2: Adding an `INSPECTION` state to `ServiceStatus`*. Rejected to preserve the core finite state machine (`DUE -> BOOKED -> IN_SERVICE -> COMPLETED`) without breaking existing transitions or requiring migration of historical statuses.
  * *Alternative 3: AuditLog foreign key to checklist items*. Rejected because cascading deletes would erase historical audits, and restrictive deletes would prevent cleaning up drafting errors.
* **Complexity Intentionally Avoided**:
  * No template authoring engines or master checklist cloners.
  * No WebSockets or background push workers.
  * No external form validation or UI component frameworks.
  * No new lifecycle states.

---

## What We Deliberately Did Not Build (Scope Boundaries)

To maintain high code quality, complete test coverage, and enterprise stability within the project timeline, the following stretch ideas were intentionally excluded from this milestone:
1. **Multi-Tenant Fleet Isolation**: Single-organization fleet management was prioritized. Multi-tenant partitioning was left out to avoid complex schema sharding.
2. **Real-Time GPS Telematics & Odometer Ingestion**: Replaced by robust, transactional batch CSV import with row-by-row isolation.
3. **Parts & Inventory Stock Management**: Service tickets record descriptions and notes; warehouse stock levels and SKU tracking were omitted.
4. **Push Notification Daemons / Email Dispatchers**: Overdue alerts are calculated dynamically on query, avoiding distributed cron scheduler overhead.
5. **PDF Report Generation**: Replaced by RFC 4180 CSV export and responsive UI viewports.
