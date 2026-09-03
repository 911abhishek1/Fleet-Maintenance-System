import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import dashboardRoutes, { getStartOfWeek, getEndOfWeek, getLatest8Weeks } from './dashboard';

describe('Fleet Maintenance Dashboard Integration Tests', () => {
  const timestamp = Date.now();
  let server: any;
  let baseUrl: string;

  let managerId: string;
  let tech1Id: string;
  let tech2Id: string;
  let managerToken: string;
  let tech1Token: string;
  let tech2Token: string;

  let activeVehicle1Id: string;
  let activeVehicle2Id: string;
  let activeVehicle3Id: string;
  let archivedVehicleId: string;

  let dueRecordId: string;
  let inServiceRecord1Id: string;
  let inServiceRecord2Id: string;
  let completedThisWeekId: string;
  let completed4WeeksAgoId: string;
  let overdueRecordId: string;
  let archivedRecordId: string;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const now = new Date();
  const startOfThisWeek = getStartOfWeek(now);
  const endOfThisWeek = getEndOfWeek(now);

  before(async () => {
    // 1. Create Users
    const manager = await prisma.user.create({
      data: {
        email: `dash_mgr_${timestamp}@test.com`,
        passwordHash: 'hash',
        role: 'FLEET_MANAGER',
      },
    });
    managerId = manager.id;

    const tech1 = await prisma.user.create({
      data: {
        email: `dash_tech1_${timestamp}@test.com`,
        passwordHash: 'hash',
        role: 'TECHNICIAN',
      },
    });
    tech1Id = tech1.id;

    const tech2 = await prisma.user.create({
      data: {
        email: `dash_tech2_${timestamp}@test.com`,
        passwordHash: 'hash',
        role: 'TECHNICIAN',
      },
    });
    tech2Id = tech2.id;

    const jwtSecret = process.env.JWT_SECRET || 'development_secret_key';
    managerToken = jwt.sign({ id: managerId, role: 'FLEET_MANAGER' }, jwtSecret);
    tech1Token = jwt.sign({ id: tech1Id, role: 'TECHNICIAN' }, jwtSecret);
    tech2Token = jwt.sign({ id: tech2Id, role: 'TECHNICIAN' }, jwtSecret);

    // 2. Create Vehicles
    // v1: Due by mileage (odometer 20000 >= 10000 + 10000)
    const v1 = await prisma.vehicle.create({
      data: {
        registration: `DSH-V1-${timestamp}`,
        make: 'Volvo',
        model: 'FH',
        odometer: 20000,
        lastServiceMileage: 10000,
        lastServiceDate: now,
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10000,
        archived: false,
      },
    });
    activeVehicle1Id = v1.id;

    // v2: In Service vehicle
    const v2 = await prisma.vehicle.create({
      data: {
        registration: `DSH-V2-${timestamp}`,
        make: 'Scania',
        model: 'R450',
        odometer: 15000,
        lastServiceMileage: 10000,
        lastServiceDate: now,
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10000,
        archived: false,
      },
    });
    activeVehicle2Id = v2.id;

    // v3: Overdue vehicle
    const v3 = await prisma.vehicle.create({
      data: {
        registration: `DSH-V3-${timestamp}`,
        make: 'DAF',
        model: 'XF',
        odometer: 12000,
        lastServiceMileage: 10000,
        lastServiceDate: now,
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10000,
        archived: false,
      },
    });
    activeVehicle3Id = v3.id;

    // vArchived: Archived vehicle that has DUE condition and services
    const vArchived = await prisma.vehicle.create({
      data: {
        registration: `DSH-VARCH-${timestamp}`,
        make: 'MAN',
        model: 'TGX',
        odometer: 50000,
        lastServiceMileage: 10000,
        lastServiceDate: new Date(now.getTime() - 200 * MS_PER_DAY),
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10000,
        archived: true,
      },
    });
    archivedVehicleId = vArchived.id;

    // 3. Service Records
    // Record 1: DUE on activeVehicle1, assigned to tech1
    const r1 = await prisma.serviceRecord.create({
      data: {
        vehicleId: activeVehicle1Id,
        description: 'Scheduled Due Service',
        status: 'DUE',
        cycle: 1,
        dueDate: now,
        assignments: { create: { userId: tech1Id } },
      },
    });
    dueRecordId = r1.id;

    // Record 2: IN_SERVICE on activeVehicle1, assigned to tech1
    const r2 = await prisma.serviceRecord.create({
      data: {
        vehicleId: activeVehicle1Id,
        description: 'Active Repair Work 1',
        status: 'IN_SERVICE',
        cycle: 1,
        dateScheduled: now,
        assignments: { create: { userId: tech1Id } },
      },
    });
    inServiceRecord1Id = r2.id;

    // Record 3: IN_SERVICE on activeVehicle2, assigned to tech2
    const r3 = await prisma.serviceRecord.create({
      data: {
        vehicleId: activeVehicle2Id,
        description: 'Active Repair Work 2',
        status: 'IN_SERVICE',
        cycle: 1,
        dateScheduled: now,
        assignments: { create: { userId: tech2Id } },
      },
    });
    inServiceRecord2Id = r3.id;

    // Record 4: COMPLETED This Week on activeVehicle1, assigned to tech1
    // Place dateCompleted right in the middle of this week
    const midWeek = new Date((startOfThisWeek.getTime() + endOfThisWeek.getTime()) / 2);
    const r4 = await prisma.serviceRecord.create({
      data: {
        vehicleId: activeVehicle1Id,
        description: 'Completed Service This Week',
        status: 'COMPLETED',
        cycle: 1,
        dateCompleted: midWeek,
        completedOdometer: 20000,
        assignments: { create: { userId: tech1Id } },
      },
    });
    completedThisWeekId = r4.id;

    // Record 5: COMPLETED 4 Weeks Ago on activeVehicle2, assigned to tech2
    const fourWeeksAgo = new Date(startOfThisWeek.getTime() - 25 * MS_PER_DAY);
    const r5 = await prisma.serviceRecord.create({
      data: {
        vehicleId: activeVehicle2Id,
        description: 'Completed Service 4 Weeks Ago',
        status: 'COMPLETED',
        cycle: 1,
        dateCompleted: fourWeeksAgo,
        completedOdometer: 14000,
        assignments: { create: { userId: tech2Id } },
      },
    });
    completed4WeeksAgoId = r5.id;

    // Record 6: Overdue Service on activeVehicle3 (dueDate 15 days ago), assigned to tech1
    const fifteenDaysAgo = new Date(now.getTime() - 15 * MS_PER_DAY);
    const r6 = await prisma.serviceRecord.create({
      data: {
        vehicleId: activeVehicle3Id,
        description: 'Overdue Brake Inspection',
        status: 'DUE',
        cycle: 1,
        dueDate: fifteenDaysAgo,
        assignments: { create: { userId: tech1Id } },
      },
    });
    overdueRecordId = r6.id;

    // Record 7: Service on ARCHIVED vehicle (should be ignored by active metrics)
    const r7 = await prisma.serviceRecord.create({
      data: {
        vehicleId: archivedVehicleId,
        description: 'Archived Vehicle Service',
        status: 'IN_SERVICE',
        cycle: 1,
        dateScheduled: now,
        assignments: { create: { userId: tech1Id } },
      },
    });
    archivedRecordId = r7.id;

    // Setup Express App
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', dashboardRoutes);

    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as any).port}`;
  });

  after(async () => {
    if (server) server.close();

    await prisma.technicianAssignment.deleteMany({
      where: {
        serviceRecord: {
          vehicleId: { in: [activeVehicle1Id, activeVehicle2Id, activeVehicle3Id, archivedVehicleId] },
        },
      },
    });
    await prisma.serviceRecord.deleteMany({
      where: {
        vehicleId: { in: [activeVehicle1Id, activeVehicle2Id, activeVehicle3Id, archivedVehicleId] },
      },
    });
    await prisma.vehicle.deleteMany({
      where: { id: { in: [activeVehicle1Id, activeVehicle2Id, activeVehicle3Id, archivedVehicleId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [managerId, tech1Id, tech2Id] } },
    });
  });

  describe('Calendar Week & 8-Week Window Domain Helpers', () => {
    it('1. getStartOfWeek returns Monday 00:00:00.000 for any day in the week', () => {
      // Wednesday midday
      const wed = new Date(Date.UTC(2026, 8, 2, 12, 0, 0));
      const start = getStartOfWeek(wed);
      assert.equal(start.getDay(), 1, 'Start of week must be Monday');
      assert.equal(start.getHours(), 0);
      assert.equal(start.getMinutes(), 0);
      assert.equal(start.getSeconds(), 0);
      assert.equal(start.getMilliseconds(), 0);

      // Sunday midday
      const sun = new Date(Date.UTC(2026, 8, 6, 12, 0, 0));
      const startFromSun = getStartOfWeek(sun);
      assert.equal(startFromSun.getTime(), start.getTime(), 'Sunday should resolve to the same week Monday');
    });

    it('2. getEndOfWeek returns Sunday 23:59:59.999', () => {
      const wed = new Date('2026-09-02T14:30:00.000Z');
      const end = getEndOfWeek(wed);
      assert.equal(end.getDay(), 0, 'End of week must be Sunday');
      assert.equal(end.getHours(), 23);
      assert.equal(end.getMinutes(), 59);
      assert.equal(end.getSeconds(), 59);
      assert.equal(end.getMilliseconds(), 999);
    });

    it('3. getLatest8Weeks returns exactly 8 weeks chronologically', () => {
      const weeks = getLatest8Weeks(now);
      assert.equal(weeks.length, 8);
      for (let i = 0; i < 7; i++) {
        const curr = new Date(weeks[i].startDate).getTime();
        const next = new Date(weeks[i + 1].startDate).getTime();
        assert.ok(curr < next, 'Weeks must be in chronological order');
      }
      assert.equal(weeks[7].weekLabel.includes('This Week'), true);
    });
  });

  describe('Security & Authentication', () => {
    it('4. Unauthorized request without token is rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard`);
      assert.equal(res.status, 401);
    });
  });

  describe('Fleet Manager Metrics (Fleet-wide)', () => {
    it('5. Fleet Manager receives all fleet-wide metrics', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      // Check top-level keys
      assert.ok('vehiclesDue' in data);
      assert.ok('vehiclesInService' in data);
      assert.ok('completedThisWeek' in data);
      assert.ok('overdue' in data);
      assert.ok('statusBreakdown' in data);
      assert.ok('technicianBreakdown' in data);
      assert.ok('completedLast8Weeks' in data);

      // vehiclesDue: activeVehicle1 (odometer 20000 >= 20000 threshold)
      assert.ok(data.vehiclesDue >= 1);

      // vehiclesInService: distinct vehicles activeVehicle1 and activeVehicle2
      assert.ok(data.vehiclesInService >= 2);

      // completedThisWeek: record 4 completed this week
      assert.ok(data.completedThisWeek >= 1);

      // overdue: record 6 is overdue (15 days ago > 7 days grace)
      assert.ok(data.overdue >= 1);

      // statusBreakdown: has all 4 statuses
      assert.ok(data.statusBreakdown.DUE >= 2);
      assert.ok(data.statusBreakdown.IN_SERVICE >= 2);
      assert.ok(data.statusBreakdown.COMPLETED >= 2);
      assert.equal(typeof data.statusBreakdown.BOOKED, 'number');

      // technicianBreakdown: includes tech1 and tech2
      const techEmails = data.technicianBreakdown.map((t: any) => t.email);
      assert.ok(techEmails.some((e: string) => e.includes('dash_tech1')));
      assert.ok(techEmails.some((e: string) => e.includes('dash_tech2')));

      // completedLast8Weeks: 8 weeks array
      assert.equal(data.completedLast8Weeks.length, 8);
      const totalIn8Weeks = data.completedLast8Weeks.reduce((acc: number, w: any) => acc + w.count, 0);
      assert.ok(totalIn8Weeks >= 2, 'Should count both this week and 4 weeks ago completions');
    });

    it('6. Archived vehicles are excluded from active operational metrics', async () => {
      // Fetch initial count with activeVehicle1 active
      const res1 = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      const data1 = await res1.json();
      const initialInService = data1.vehiclesInService;

      // Now archive activeVehicle1 (which has inServiceRecord1Id)
      await prisma.vehicle.update({
        where: { id: activeVehicle1Id },
        data: { archived: true },
      });

      const res2 = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      const data2 = await res2.json();

      // In-service vehicles must decrease by exactly 1
      assert.equal(
        data2.vehiclesInService,
        initialInService - 1,
        'Archiving a vehicle must decrease active vehiclesInService count by 1'
      );

      // Restore activeVehicle1
      await prisma.vehicle.update({
        where: { id: activeVehicle1Id },
        data: { archived: false },
      });
    });
  });

  describe('Technician Scoping & Zero-Leakage', () => {
    it('7. Technician 1 only receives metrics for assigned services', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      // Tech 1 has inService on activeVehicle1 only (1 vehicle), not activeVehicle2
      assert.equal(data.vehiclesInService, 1);

      // completedThisWeek: tech 1 completed Record 4
      assert.equal(data.completedThisWeek, 1);

      // Overdue: tech 1 assigned to overdue Record 6
      assert.equal(data.overdue, 1);

      // technicianBreakdown: MUST only contain Tech 1, never Tech 2 or others!
      assert.equal(data.technicianBreakdown.length, 1);
      assert.equal(data.technicianBreakdown[0].technicianId, tech1Id);
      assert.equal(data.technicianBreakdown[0].email, `dash_tech1_${timestamp}@test.com`);

      // 8-week completed should count Record 4 (this week), but NOT Record 5 (tech 2)
      const thisWeekBucket = data.completedLast8Weeks[7];
      assert.equal(thisWeekBucket.count, 1);
      const fourWeeksAgoBucket = data.completedLast8Weeks.find(
        (w: any) => new Date(w.startDate) <= new Date(startOfThisWeek.getTime() - 25 * MS_PER_DAY) &&
                    new Date(w.endDate) >= new Date(startOfThisWeek.getTime() - 25 * MS_PER_DAY)
      );
      if (fourWeeksAgoBucket) {
        assert.equal(fourWeeksAgoBucket.count, 0, 'Tech 1 should NOT see Tech 2 completion 4 weeks ago');
      }
    });

    it('8. Technician 2 sees only their own assigned records', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${tech2Token}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      // Tech 2 has inService on activeVehicle2 only (1 vehicle)
      assert.equal(data.vehiclesInService, 1);

      // completedThisWeek: 0 (Tech 2 completed 4 weeks ago, not this week)
      assert.equal(data.completedThisWeek, 0);

      // Overdue: 0 (Tech 2 has no overdue records)
      assert.equal(data.overdue, 0);

      // technicianBreakdown: MUST only contain Tech 2
      assert.equal(data.technicianBreakdown.length, 1);
      assert.equal(data.technicianBreakdown[0].technicianId, tech2Id);
      assert.equal(data.technicianBreakdown[0].email, `dash_tech2_${timestamp}@test.com`);
    });
  });

  describe('Completed-This-Week Boundary & 8-Week Buckets', () => {
    it('9. Exact boundaries for completedThisWeek are respected', async () => {
      // Create a service record completed 1 ms before the start of this week
      const oneMsBeforeWeek = new Date(startOfThisWeek.getTime() - 1);
      await prisma.serviceRecord.create({
        data: {
          vehicleId: activeVehicle1Id,
          description: 'Completed just before week start',
          status: 'COMPLETED',
          cycle: 1,
          dateCompleted: oneMsBeforeWeek,
          completedOdometer: 21000,
          assignments: { create: { userId: tech1Id } },
        },
      });

      const res = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      // completedThisWeek should still be 1, because oneMsBeforeWeek is outside this week!
      assert.equal(data.completedThisWeek, 1, 'Service completed before week start must not count in this week');
    });

    it('10. Weeks with zero completions have count 0', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      // Find at least one zero-count week in the 8-week array
      const zeroWeeks = data.completedLast8Weeks.filter((w: any) => w.count === 0);
      assert.ok(zeroWeeks.length > 0, 'Must have weeks with count = 0');
      assert.equal(data.completedLast8Weeks.length, 8, 'Must return exactly 8 weeks');
    });
  });
});
