import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import alertRoutes from './alerts';
import serviceRoutes from './services';
import { updateServiceRecord } from '../services/serviceLifecycle';
import { isServiceOverdue } from '../domain/maintenance';

describe('Overdue Service Alerts Integration Tests', () => {
  const timestamp = Date.now();
  let server: any;
  let baseUrl: string;

  let managerId: string;
  let tech1Id: string;
  let tech2Id: string;
  let managerToken: string;
  let tech1Token: string;
  let tech2Token: string;

  let vehicle1Id: string;
  let vehicle2Id: string;
  let vehicle3Id: string;

  let dueOverdueRecordId: string;
  let bookedOverdueRecordId: string;
  let inServiceRecordId: string;
  let completedRecordId: string;
  let futureDueRecordId: string;
  let boundaryRecordId: string;
  let tech2OverdueRecordId: string;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const GRACE_PERIOD_DAYS = 7;

  before(async () => {
    // 1. Create Users
    const manager = await prisma.user.create({
      data: {
        email: `alert_mgr_${timestamp}@test.com`,
        passwordHash: 'hash',
        role: 'FLEET_MANAGER',
      },
    });
    managerId = manager.id;

    const tech1 = await prisma.user.create({
      data: {
        email: `alert_tech1_${timestamp}@test.com`,
        passwordHash: 'hash',
        role: 'TECHNICIAN',
      },
    });
    tech1Id = tech1.id;

    const tech2 = await prisma.user.create({
      data: {
        email: `alert_tech2_${timestamp}@test.com`,
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
    const now = new Date();

    const v1 = await prisma.vehicle.create({
      data: {
        registration: `ALR-V1-${timestamp}`,
        make: 'Volvo',
        model: 'FH',
        odometer: 10000,
        lastServiceMileage: 10000,
        lastServiceDate: now,
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10000,
      },
    });
    vehicle1Id = v1.id;

    const v2 = await prisma.vehicle.create({
      data: {
        registration: `ALR-V2-${timestamp}`,
        make: 'Scania',
        model: 'R450',
        odometer: 20000,
        lastServiceMileage: 20000,
        lastServiceDate: now,
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10000,
      },
    });
    vehicle2Id = v2.id;

    const v3 = await prisma.vehicle.create({
      data: {
        registration: `ALR-V3-${timestamp}`,
        make: 'MAN',
        model: 'TGX',
        odometer: 30000,
        lastServiceMileage: 30000,
        lastServiceDate: now,
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10000,
      },
    });
    vehicle3Id = v3.id;

    // 3. Service Records
    // Overdue cutoff is dueDate + 7 days.
    // 10 days ago -> overdue cutoff was 3 days ago -> OVERDUE
    const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);
    // 5 days in future -> NEVER overdue
    const fiveDaysFuture = new Date(now.getTime() + 5 * MS_PER_DAY);

    // Record 1: DUE status, 10 days ago (Overdue), assigned to tech1
    const r1 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicle1Id,
        description: 'DUE Overdue Service',
        status: 'DUE',
        cycle: 1,
        dueDate: tenDaysAgo,
        assignments: { create: { userId: tech1Id } },
      },
    });
    dueOverdueRecordId = r1.id;

    // Record 2: BOOKED status, 10 days ago (Overdue), assigned to tech1
    const r2 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicle2Id,
        description: 'BOOKED Overdue Service',
        status: 'BOOKED',
        cycle: 1,
        dueDate: tenDaysAgo,
        dateScheduled: tenDaysAgo,
        assignments: { create: { userId: tech1Id } },
      },
    });
    bookedOverdueRecordId = r2.id;

    // Record 3: IN_SERVICE status, 10 days ago
    const r3 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicle1Id,
        description: 'IN_SERVICE Record',
        status: 'IN_SERVICE',
        cycle: 1,
        dueDate: tenDaysAgo,
        dateScheduled: tenDaysAgo,
      },
    });
    inServiceRecordId = r3.id;

    // Record 4: COMPLETED status, 10 days ago
    const r4 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicle1Id,
        description: 'COMPLETED Record',
        status: 'COMPLETED',
        cycle: 1,
        dueDate: tenDaysAgo,
        dateCompleted: now,
        completedOdometer: 10500,
      },
    });
    completedRecordId = r4.id;

    // Record 5: DUE status, 5 days future
    const r5 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicle1Id,
        description: 'Future Due Record',
        status: 'DUE',
        cycle: 1,
        dueDate: fiveDaysFuture,
      },
    });
    futureDueRecordId = r5.id;

    // Record 6: Overdue Record assigned only to tech2
    const r6 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicle3Id,
        description: 'Tech2 Overdue Record',
        status: 'DUE',
        cycle: 1,
        dueDate: tenDaysAgo,
        assignments: { create: { userId: tech2Id } },
      },
    });
    tech2OverdueRecordId = r6.id;

    // Setup Express Server
    const app = express();
    app.use(express.json());
    app.use('/api/alerts', alertRoutes);
    app.use('/api/services', serviceRoutes);

    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as any).port}`;
  });

  after(async () => {
    if (server) server.close();

    await prisma.technicianAssignment.deleteMany({
      where: { serviceRecord: { vehicleId: { in: [vehicle1Id, vehicle2Id, vehicle3Id] } } },
    });
    await prisma.auditLog.deleteMany({
      where: { vehicleId: { in: [vehicle1Id, vehicle2Id, vehicle3Id] } },
    });
    await prisma.serviceRecord.deleteMany({
      where: { vehicleId: { in: [vehicle1Id, vehicle2Id, vehicle3Id] } },
    });
    await prisma.vehicle.deleteMany({
      where: { id: { in: [vehicle1Id, vehicle2Id, vehicle3Id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [managerId, tech1Id, tech2Id] } },
    });
  });

  describe('Overdue Condition Domain Checks', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');

    it('1. DUE service becomes overdue after grace period', () => {
      // 8 days before evaluation -> dueDate + 7 days was yesterday -> overdue
      const dueDate = new Date(now.getTime() - 8 * MS_PER_DAY);
      const res = isServiceOverdue({
        status: 'DUE',
        dueDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        evaluationTime: now,
      });
      assert.equal(res, true);
    });

    it('2. BOOKED service becomes overdue after grace period', () => {
      const dueDate = new Date(now.getTime() - 8 * MS_PER_DAY);
      const res = isServiceOverdue({
        status: 'BOOKED',
        dueDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        evaluationTime: now,
      });
      assert.equal(res, true);
    });

    it('3. IN_SERVICE is never overdue', () => {
      const dueDate = new Date(now.getTime() - 20 * MS_PER_DAY);
      const res = isServiceOverdue({
        status: 'IN_SERVICE',
        dueDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        evaluationTime: now,
      });
      assert.equal(res, false);
    });

    it('4. COMPLETED is never overdue', () => {
      const dueDate = new Date(now.getTime() - 20 * MS_PER_DAY);
      const res = isServiceOverdue({
        status: 'COMPLETED',
        dueDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        evaluationTime: now,
      });
      assert.equal(res, false);
    });

    it('5. Future dueDate is not overdue', () => {
      const dueDate = new Date(now.getTime() + 2 * MS_PER_DAY);
      const res = isServiceOverdue({
        status: 'DUE',
        dueDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        evaluationTime: now,
      });
      assert.equal(res, false);
    });

    it('6. Exact grace-period boundary is not overdue', () => {
      // now === dueDate + 7 days
      const dueDate = new Date(now.getTime() - 7 * MS_PER_DAY);
      const res = isServiceOverdue({
        status: 'DUE',
        dueDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        evaluationTime: now,
      });
      assert.equal(res, false, 'Exactly on cutoff boundary is not overdue');
    });

    it('7. One moment after grace period is overdue', () => {
      // now === dueDate + 7 days + 1 ms
      const dueDate = new Date(now.getTime() - (7 * MS_PER_DAY + 1));
      const res = isServiceOverdue({
        status: 'DUE',
        dueDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        evaluationTime: now,
      });
      assert.equal(res, true, 'One moment after grace period must be overdue');
    });
  });

  describe('Alerts API & Scoping', () => {
    it('8. Manager can retrieve overdue alerts', async () => {
      const res = await fetch(`${baseUrl}/api/alerts`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      const ids = data.alerts.map((a: any) => a.id);
      assert.ok(ids.includes(dueOverdueRecordId));
      assert.ok(ids.includes(bookedOverdueRecordId));
      assert.ok(ids.includes(tech2OverdueRecordId));
      assert.ok(!ids.includes(inServiceRecordId), 'IN_SERVICE must not be in alerts');
      assert.ok(!ids.includes(completedRecordId), 'COMPLETED must not be in alerts');
      assert.ok(!ids.includes(futureDueRecordId), 'Future dueDate must not be in alerts');
    });

    it('9. Technician retrieves only assigned overdue alerts', async () => {
      const res = await fetch(`${baseUrl}/api/alerts`, {
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      const ids = data.alerts.map((a: any) => a.id);
      assert.ok(ids.includes(dueOverdueRecordId));
      assert.ok(ids.includes(bookedOverdueRecordId));
      assert.ok(!ids.includes(tech2OverdueRecordId), 'Tech 1 should not see Tech 2 alert');
    });

    it('10. Technician cannot see another technician overdue alert via query params', async () => {
      const res = await fetch(`${baseUrl}/api/alerts?technicianId=${tech2Id}`, {
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      const ids = data.alerts.map((a: any) => a.id);
      assert.ok(!ids.includes(tech2OverdueRecordId), 'Technician scope must ignore query params');
    });
  });

  describe('Dismissal & Cycle Mechanics', () => {
    it('11. Manager can dismiss an overdue alert', async () => {
      const res = await fetch(`${baseUrl}/api/alerts/${dueOverdueRecordId}/dismiss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.dismissedAlertCycle, 1);

      const v1 = await prisma.vehicle.findUnique({ where: { id: vehicle1Id } });
      assert.equal(v1?.dismissedAlertCycle, 1);
    });

    it('12. Technician cannot dismiss an alert', async () => {
      const res = await fetch(`${baseUrl}/api/alerts/${bookedOverdueRecordId}/dismiss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 403);
    });

    it('13. Dismissed alert is hidden for the current cycle', async () => {
      const res = await fetch(`${baseUrl}/api/alerts`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const ids = data.alerts.map((a: any) => a.id);
      assert.ok(!ids.includes(dueOverdueRecordId), 'Dismissed alert must be hidden');
    });

    it('14. Completing service increments serviceCycle and does not preserve old dismissal', async () => {
      // Complete service on vehicle 1
      await updateServiceRecord(
        dueOverdueRecordId,
        { id: managerId, role: 'FLEET_MANAGER' },
        { status: 'BOOKED', dateScheduled: new Date().toISOString() }
      );
      await updateServiceRecord(
        dueOverdueRecordId,
        { id: managerId, role: 'FLEET_MANAGER' },
        { status: 'IN_SERVICE' }
      );
      await updateServiceRecord(
        dueOverdueRecordId,
        { id: managerId, role: 'FLEET_MANAGER' },
        { status: 'COMPLETED', completedOdometer: 11000 }
      );

      const v1 = await prisma.vehicle.findUnique({ where: { id: vehicle1Id } });
      assert.equal(v1?.serviceCycle, 2, 'serviceCycle should increment to 2');
      assert.equal(v1?.dismissedAlertCycle, 1, 'dismissedAlertCycle should stay 1 (cycle 1 dismissal only)');
    });

    it('15. New cycle becoming overdue produces a visible alert again', async () => {
      const pastDueDate = new Date(Date.now() - 15 * MS_PER_DAY);

      // Create new cycle 2 service record on vehicle 1 that is overdue
      const newCycleRecord = await prisma.serviceRecord.create({
        data: {
          vehicleId: vehicle1Id,
          description: 'Cycle 2 Overdue Service',
          status: 'DUE',
          cycle: 2,
          dueDate: pastDueDate,
        },
      });

      const res = await fetch(`${baseUrl}/api/alerts`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const ids = data.alerts.map((a: any) => a.id);

      assert.ok(
        ids.includes(newCycleRecord.id),
        'New cycle overdue record must appear because dismissedAlertCycle (1) !== serviceCycle (2)'
      );
    });

    it('16. Invalid/non-overdue dismissal is rejected', async () => {
      // futureDueRecordId is not overdue
      const res = await fetch(`${baseUrl}/api/alerts/${futureDueRecordId}/dismiss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('not currently overdue'));
    });

    it('17. Alert dismissal creates an ALERT_DISMISSED audit event', async () => {
      // Dismiss bookedOverdueRecordId on vehicle 2
      const res = await fetch(`${baseUrl}/api/alerts/${bookedOverdueRecordId}/dismiss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          vehicleId: vehicle2Id,
          serviceRecordId: bookedOverdueRecordId,
          action: 'ALERT_DISMISSED',
        },
      });

      assert.ok(auditLog);
      assert.equal(auditLog.changedById, managerId);
      assert.equal(auditLog.newValue, '1');
    });

    it('18. Alert dismissal + audit are atomic', async () => {
      // Attempting to dismiss the already-dismissed record should fail with 400
      // and not write a second audit log
      const countBefore = await prisma.auditLog.count({
        where: {
          vehicleId: vehicle2Id,
          action: 'ALERT_DISMISSED',
        },
      });

      const res = await fetch(`${baseUrl}/api/alerts/${bookedOverdueRecordId}/dismiss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 400);

      const countAfter = await prisma.auditLog.count({
        where: {
          vehicleId: vehicle2Id,
          action: 'ALERT_DISMISSED',
        },
      });
      assert.equal(countBefore, countAfter);
    });
  });
});
