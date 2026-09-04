# Fleet Maintenance Management System (FleetPro)

A full-stack fleet maintenance tracking and operations platform built to manage vehicle service lifecycles, schedule maintenance according to mileage and date intervals, enforce technician permissions, track immutable audit events, monitor real-time fleet health via an operational dashboard, and conduct vehicle inspection checklists.

---

## Key Links

* **[SUBMISSION.md](./SUBMISSION.md)** — Assignment submission overview, setup instructions, verified features, and evaluation notes.
* **[Architecture Guide](./docs/architecture.md)** — In-depth system topology, domain layer, transaction boundaries, and RBAC scoping.
* **[Database Schema & Migrations](./docs/schema.md)** — Entity Relationship Diagram, table schemas, maintenance cycle modeling, and indexes.
* **[Implementation Plan & History](./docs/plan.md)** — Chronological roadmap mapping verified git commits to milestones.
* **[Architecture Decision Records (ADRs)](./docs/decisions.md)** — Rationale for key technical decisions and tradeoffs.
* **[AI Prompts & Development Log](./docs/ai-prompts.md)** — Transparency log of prompts and AI assistance used during development.

---

## Technology Stack

* **Backend**: Node.js (v20+), TypeScript, Express 5, Prisma ORM 7 (`@prisma/client`, `@prisma/adapter-pg`, PostgreSQL `pg` driver).
* **Database**: PostgreSQL with Prisma migrations.
* **Frontend**: Vanilla TypeScript SPA, Vite 8, pure CSS design system (dark mode, glassmorphism, responsive SVG chart, zero heavy charting libraries).
* **Authentication**: JWT authentication stored in HTTP-only cookies and Authorization headers, with bcrypt password hashing.
* **Testing**: Node.js native test runner (`node:test` + `node:assert/strict`), driven via `tsx`.

---

## Repository Structure

```text
Busy_Dummy/
├── docs/                        # Complete technical documentation
│   ├── architecture.md          # Topology, domain engine, RBAC, transaction flows
│   ├── schema.md                # ERD, tables, baseline cycles, indexes, migrations
│   ├── plan.md                  # Milestone implementation roadmap with commit hashes
│   ├── decisions.md             # Architecture Decision Records (ADRs)
│   └── ai-prompts.md            # AI prompts and assistance disclosure
├── backend/                     # Express.js REST API & domain engine
│   ├── prisma/
│   │   ├── schema.prisma        # Prisma schema definition
│   │   └── migrations/          # Applied SQL migration history
│   ├── src/
│   │   ├── config.ts            # Environment and runtime configurations
│   │   ├── db.ts                # PrismaClient instance with PostgreSQL adapter
│   │   ├── index.ts             # Express server setup and route mounting
│   │   ├── domain/              # Pure domain logic (maintenance, lifecycle, audit)
│   │   ├── middleware/          # Authentication and RBAC guards
│   │   ├── routes/              # Route handlers (auth, vehicles, services, alerts, dashboard)
│   │   └── services/            # Transactional lifecycle services
│   ├── package.json             # Backend dependencies and scripts
│   └── tsconfig.json            # TypeScript configuration
├── frontend/                    # Vite + TypeScript SPA
│   ├── public/                  # Static assets & icons
│   ├── src/
│   │   ├── api.ts               # Axios API client modules
│   │   ├── components/          # Reusable UI components (layout, modal, toast)
│   │   ├── pages/               # Page views (login, dashboard, vehicles, services, alerts)
│   │   ├── router.ts            # Client-side hash/path router
│   │   ├── state.ts             # Auth and session state
│   │   ├── style.css            # Custom CSS design system
│   │   └── main.ts              # Frontend entry point
│   ├── package.json             # Frontend dependencies and scripts
│   └── tsconfig.json            # TypeScript configuration
├── README.md                    # Project landing page
└── SUBMISSION.md                # Assignment submission document
```

---

## Quick Setup & Run Instructions

### Prerequisites
* **Node.js**: v20.x or v22.x
* **PostgreSQL**: Local or hosted PostgreSQL database instance
* **npm**: v10+

### 1. Backend Setup
```bash
cd backend
npm install
```

Create a `.env` file in the `backend/` directory:
```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/fleet_db?schema=public"
JWT_SECRET="development_secret_key"
PORT=5000
FRONTEND_URL="http://localhost:5173"
OVERDUE_GRACE_PERIOD_DAYS=7
```

Apply database migrations:
```bash
npx prisma migrate deploy
npx prisma generate
```

Start the backend development server:
```bash
npm run dev
# Backend runs at http://localhost:5000
```

### 2. Frontend Setup
```bash
cd ../frontend
npm install
npm run dev
# Frontend runs at http://localhost:5173
```

---

## Running Automated Tests

All tests run using the Node.js native test runner (`node:test`) and verify database integration, domain rules, CSV handling, server-side pagination, alerts, and dashboard metrics:

```bash
cd backend
npm test
```

### Static Type Checking
```bash
# Backend type check
cd backend
npx tsc --noEmit

# Frontend type check
cd ../frontend
npx tsc --noEmit
```
