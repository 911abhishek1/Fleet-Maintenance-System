# AI Prompts & Development Transparency Log

This document provides full transparency regarding the use of AI assistance during the development of the Fleet Maintenance System.

---

## 1. Overview of AI Assistance

Development of this repository was conducted collaboratively with **Antigravity**, an agentic AI coding assistant developed by Google DeepMind. The AI assistant was utilized for:
* Repository auditing and gap analysis against assignment requirements.
* Test-driven development (authoring unit and integration tests using `node:test`).
* Implementing pure domain mathematical modules and state machine validators.
* Authoring database migrations and backfill scripts using Prisma ORM.
* Hardening server-side query scoping, multipart CSV parsing, and atomic transactions.
* Building UI pages and lightweight SVG visualizations.

All architectural decisions, code modifications, and commits were guided by explicit human prompts, followed by automated test suite verification before committing.

---

## 2. Chronological Log of Prompts & Instructions

The following prompts represent the actual instructions issued across the project trajectory, extracted from the development session history. Where prompts are verbatim quotations from session logs, they are denoted as `[VERBATIM]`. Where conversational exchanges were condensed for readability, they are denoted as `[SUMMARY]`.

---

### Phase 1: Repository Audit & Gap Analysis
* **Prompt Type**: `[VERBATIM]`
* **Instruction**:
  > "We already have an existing Fleet Maintenance System repository.
  > Do NOT write major application code yet.
  > First inspect the entire existing repository and compare the current implementation against the Fleet Maintenance assignment requirements that are provided in the project/context.
  > I want a gap analysis and safe migration plan.
  > Analyze:
  > 1. Existing frontend architecture
  > 2. Existing backend architecture
  > 3. Existing Prisma schema
  > 4. Existing authentication and authorization
  > 5. Existing vehicle functionality
  > 6. Existing service-record functionality
  > 7. Existing lifecycle/business logic
  > 8. Existing technician assignment
  > 9. Existing search/filter/pagination
  > 10. Existing CSV import/export
  > 11. Existing audit logging
  > 12. Existing overdue logic
  > 13. Existing dashboard functionality
  > 14. Existing tests
  > 15. Existing documentation
  > 16. Existing Git history
  > Pay special attention to these business rules:
  > - Due → Booked → In Service → Completed
  > - invalid lifecycle transitions rejected by the server
  > - service due when either date OR mileage interval is reached
  > - completion resets both service baselines
  > - technician permissions enforced server-side
  > - server-side filtering/sorting/pagination
  > - partial-success CSV import
  > - immutable audit history
  > - overdue grace-period behavior
  > - alert dismissal must apply to a service cycle, not permanently to a vehicle"

---

### Phase 2: Milestone 1 — Technician Assignment Workflow
* **Prompt Type**: `[SUMMARY]`
* **Commit**: `34a019c`
* **Instruction**:
  > Implement atomic technician assignment and unassignment endpoints (`POST /api/services/:id/assignments` and `DELETE /api/services/:id/assignments/:technicianId`). Enforce Fleet Manager authorization and verify technician roles. Ensure assignment mutations and audit log events are committed together in atomic Prisma transactions. Do not modify the database schema yet.

---

### Phase 3: Milestone 2 — Maintenance Cycle Tracking Schema
* **Prompt Type**: `[SUMMARY]`
* **Commit**: `a070508`
* **Instruction**:
  > Add maintenance cycle tracking fields to the Prisma schema (`serviceCycle`, `dismissedAlertCycle`, `lastServiceDate`, `lastServiceMileage`, `dateIntervalDays`, `mileageInterval` on `Vehicle`, and `cycle` on `ServiceRecord`). Write a safe migration with deterministic data backfill to initialize baseline maintenance cycles for existing vehicles without corrupting historical data.

---

### Phase 4: Milestone 3 — Pure Maintenance Calculation Domain Rules
* **Prompt Type**: `[VERBATIM]`
* **Commit**: `afdb595`
* **Instruction**:
  > "The database schema/migration is now committed and the working tree is clean.
  > Start the next milestone: create the pure maintenance calculation/business-rule layer.
  > IMPORTANT:
  > - Do NOT modify Prisma schema.
  > - Do NOT modify database migrations.
  > - Do NOT implement service lifecycle mutation endpoints yet.
  > - Do NOT modify the frontend.
  > - Do NOT implement alerts yet.
  > - Do NOT change unrelated existing routes.
  > - Work only on pure business logic and its unit tests.
  > Goal: Create a small, clearly named domain/business module responsible for calculating:
  > 1. Whether a vehicle is due for service.
  > 2. The date-based maintenance threshold.
  > 3. The mileage-based maintenance threshold.
  > 4. Which threshold triggered the due state.
  > 5. The canonical dueDate for the resulting service record.
  > 6. Whether an existing Due/Booked service is overdue."

---

### Phase 5: Milestone 4 — Transactional Service Lifecycle
* **Prompt Type**: `[VERBATIM]`
* **Commit**: `ee4b7a2`
* **Instruction**:
  > "The maintenance domain calculation layer and schema are now committed and verified.
  > Next, integrate the business rules into the backend service lifecycle.
  > Strict service lifecycle: ServiceStatus must remain exactly: DUE, BOOKED, IN_SERVICE, COMPLETED.
  > Allowed transitions: DUE -> BOOKED, BOOKED -> IN_SERVICE, IN_SERVICE -> COMPLETED.
  > Everything else must be rejected by the server with a clear 400-level error explaining the invalid transition.
  > Booking requires scheduled date and assigned technician.
  > Completion requires valid completedOdometer >= current odometer, updates vehicle baselines, increments serviceCycle, and records audit log atomically in one transaction."
* **Hardening Correction**:
  > "A manually-created DUE service should represent a service that is due now. Status must always be DUE, dueDate should be the current creation time (`now`), do not allow caller-supplied dueDate, do not calculate a future projected threshold."

---

### Phase 6: Milestone 5 — Server-Side Querying & Pagination
* **Prompt Type**: `[VERBATIM]`
* **Commit**: `fd9a595`
* **Instruction**:
  > "Next implement ONLY the server-side service-record and vehicle-list querying improvements required by the assignment.
  > Support text search over service description.
  > Filters: vehicleId, status, technicianId.
  > For TECHNICIAN callers: ALWAYS restrict results on the server to records assigned to the authenticated technician. Ignore attempts by a technician to use another technicianId to expand their access.
  > Pagination: page, limit, total, totalPages.
  > Sorting: allowed fields only with ascending/descending order.
  > Do not add indexes simply because they are possible candidates; add only indexes that materially support query patterns."

---

### Phase 7: Milestone 6 — Multipart CSV Import & Export
* **Prompt Type**: `[VERBATIM]`
* **Commit**: `3cb83c9`
* **Instruction**:
  > "Implement the CSV import/export milestone ONLY.
  > Bulk odometer CSV import for Fleet Managers only using multipart/form-data.
  > Use a proper CSV parser library rather than line.split(',').
  > Validate row structure, identify vehicle, validate odometer, reject lower readings, accept equal or higher readings, continue processing after rejected rows, and return itemized per-row results.
  > Process rows sequentially: later rows for the same vehicle are checked against the latest value established by earlier rows in the same file.
  > Re-read current vehicle odometer inside each row transaction (`newOdometer >= currentDatabaseOdometer`) before updating to protect against concurrent requests.
  > Export service history to CSV with RFC 4180 escaping."

---

### Phase 8: Milestone 7 — Overdue Service Alerts & Dismissal
* **Prompt Type**: `[VERBATIM]`
* **Commit**: `0a3b7a7`
* **Instruction**:
  > "Implement ONLY the Overdue Service Alerts milestone.
  > Do NOT create a ServiceAlert table. Use existing Vehicle.serviceCycle, Vehicle.dismissedAlertCycle, and ServiceRecord.cycle.
  > Overdue condition: derived condition (status DUE or BOOKED, dueDate exists, now > dueDate + gracePeriodDays).
  > Safe grace-period configuration: accept finite values >= 0 (including 0 as immediate overdue), fall back to 7 for invalid/missing values.
  > Dismissal: Fleet Managers only via `POST /api/alerts/:id/dismiss`. Sets `Vehicle.dismissedAlertCycle = Vehicle.serviceCycle` with an `ALERT_DISMISSED` audit event in an atomic transaction.
  > When the service completes and cycle advances from 1 -> 2, the next cycle becoming overdue must surface as a new alert automatically."

---

### Phase 9: Milestone 8 — Fleet Maintenance Dashboard
* **Prompt Type**: `[VERBATIM]`
* **Commit**: `7efbc84`
* **Instruction**:
  > "Implement the next assignment milestone: Fleet Maintenance Dashboard.
  > Create server-side endpoint `GET /api/dashboard`.
  > Fleet Managers see fleet-wide metrics; Technicians only see metrics based on assigned service records. Do not leak fleet-wide technician data.
  > Return: vehiclesDue, vehiclesInService, completedThisWeek, overdue, statusBreakdown, technicianBreakdown, completedLast8Weeks.
  > Respect archived vehicles appropriately (exclude from active operational metrics).
  > Update frontend dashboard page to consume endpoint, showing 4 KPI cards, status breakdown, technician breakdown, and 8-week completed chart (using lightweight SVG rendering with zero heavy chart dependencies)."

---

### Phase 10: Quality Assurance, Hardening & E2E Bug Fixes
* **Prompt Type**: `[SUMMARY]`
* **Commits**: `f2f7053`, `f0ca8ab`, `6448efd`
* **Instruction**:
  > Complete end-to-end audit and bugfixes across frontend and backend integration:
  > - Add "Due Date" column to the frontend Services table.
  > - Add Booking modal prompting for `dateScheduled` prior to `DUE -> BOOKED` transition.
  > - Fix dashboard "Evaluate Status" response property mapping (`flaggedDue`).
  > - Fix `completedOdometer` string-to-numeric extraction in completion modal and backend transport compatibility.
  > - Restrict service creation to Fleet Managers only, initialize manually created records in `DUE` status, enforce technician assignment validation (reject assigning Fleet Managers), and prevent IDOR on single-service lookups.

---

### Phase 11: Stretch Feature — Vehicle Inspection Checklists
* **Prompt Type**: `[VERBATIM]`
* **Commit**: `UNCOMMITTED (Verification In Progress)`
* **Instruction**:
  > "You are the lead engineer extending the already-completed Fleet Maintenance System.
  >
  > IMPORTANT CONTEXT:
  > The application has already completed all 10 core assignment goals:
  > 1. Accounts/RBAC
  > 2. Vehicles
  > 3. Service records
  > 4. Service lifecycle
  > 5. Technician assignment
  > 6. Server-side service search/filter/sort/pagination
  > 7. Bulk odometer CSV + service history export
  > 8. Dashboard
  > 9. Immutable audit timeline
  > 10. Overdue alerts + cycle-aware dismissal
  >
  > Do NOT compromise, weaken, or rewrite any of these core requirements.
  >
  > We now want to add ONE optional stretch feature:
  > # VEHICLE INSPECTION CHECKLISTS
  >
  > This stretch feature must feel like a natural extension of the existing fleet-maintenance domain.
  >
  > GOAL: Allow a Fleet Manager to define and manage inspection checklist items for a vehicle/service workflow, and allow the assigned Technician to record inspection results while working on the service. The feature should be simple, useful, professional, and well integrated. Do NOT turn this into a large inspection-management platform.
  >
  > FUNCTIONAL DESIGN:
  > InspectionChecklistItem: id, serviceRecordId, title, description or guidance (optional), required boolean, status/result (PENDING, PASS, FAIL, NOT_APPLICABLE), notes, checkedBy / actor if needed, createdAt, updatedAt.
  > Checklist items belong to a SERVICE RECORD, not globally to a technician.
  >
  > ROLE RULES:
  > - Fleet Manager: Can create checklist items, edit/remove checklist items, view results, see inspection history. Administrative overrides allowed.
  > - Assigned Technician: Can view checklist items for assigned services, update result/status, add/update inspection notes. MUST NOT modify assignment or maintenance intervals. MUST NOT access unassigned services.
  > - Unassigned Technician: 403 / denied access for checklist endpoints. Server-side enforced.
  >
  > LIFECYCLE: DUE (Manager defines), BOOKED (remains visible), IN_SERVICE (Assigned tech completes), COMPLETED (read-only historical record). Do NOT alter DUE -> BOOKED -> IN_SERVICE -> COMPLETED.
  >
  > AUDIT: Preserve audit history. Do not create a FK dependency from AuditLog to checklist items. Deleting a checklist item must not delete or invalidate audit history. Material actions logged: CHECKLIST_ITEM_CREATED, CHECKLIST_RESULT_UPDATED, CHECKLIST_ITEM_DELETED. GET requests do not create audit records.
  >
  > ROUTING & ARCHITECTURE: Dedicated checklist router mounted cleanly under /api/services/:serviceId/checklist. Avoid putting checklist logic into serviceLifecycle.ts."
