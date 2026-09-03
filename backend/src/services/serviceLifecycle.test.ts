import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import serviceRoutes from '../routes/services';
import vehicleRoutes from '../routes/vehicles';
import { updateServiceRecord } from './serviceLifecycle';
import { evaluateServiceDue } from '../domain/maintenance';
import { ValidationError, ForbiddenActionError } from '../domain/lifecycle';

describe('Service Lifecycle & Integration Tests', () => {
  const timestamp = Date.now();
  let testManagerId: string;
  let testTech1Id: string;
  let testTech2Id: string;
  let testVehicleId: string;
  let server: any;
  let baseUrl: string;
  let managerToken: string;

  before(async () => {
    // Create test manager and technicians
    const manager = await prisma.user.create({
      data: {
        email: `manager_${timestamp}@test.com`,
        passwordHash: 'testhash',
        role: 'FLEET_MANAGER',
      },
    });
    testManagerId = manager.id;

    const tech1 = await prisma.user.create({
      data: {
        email: `tech1_${timestamp}@test.com`,
        passwordHash: 'testhash',
        role: 'TECHNICIAN',
      },
    });
    testTech1Id = tech1.id;

    const tech2 = await prisma.user.create({
      data: {
        email: `tech2_${timestamp}@test.com`,
        passwordHash: 'testhash',
        role: 'TECHNICIAN',
      },
    });
    testTech2Id = tech2.id;

    // Create a test vehicle
    const vehicle = await prisma.vehicle.create({
      data: {
        registration: `TEST-LIFECYCLE-${timestamp}`,
        make: 'Volvo',
        model: 'FH16',
        odometer: 50_000,
        lastServiceMileage: 50_000,
        lastServiceDate: new Date('2026-08-01T00:00:00.000Z'),
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: 90,
        mileageInterval: 10_000,
      },
    });
    testVehicleId = vehicle.id;

    // Spin up test Express app for HTTP integration tests
    const app = express();
    app.use(express.json());
    app.use('/api/services', serviceRoutes);
    app.use('/api/vehicles', vehicleRoutes);
    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as any).port}`;
    managerToken = jwt.sign(
      { id: manager.id, role: manager.role },
      process.env.JWT_SECRET || 'supersecretkey'
    );
  });

  after(async () => {
    if (server) server.close();
    // Clean up created test entities
    await prisma.auditLog.deleteMany({ where: { vehicleId: testVehicleId } });
    await prisma.technicianAssignment.deleteMany({
      where: { user: { email: { contains: String(timestamp) } } },
    });
    await prisma.serviceRecord.deleteMany({ where: { vehicleId: testVehicleId } });
    await prisma.vehicle.deleteMany({ where: { id: testVehicleId } });
    await prisma.user.deleteMany({
      where: { email: { in: [`manager_${timestamp}@test.com`, `tech1_${timestamp}@test.com`, `tech2_${timestamp}@test.com`] } },
    });
  });

  it('Full lifecycle flow: DUE -> BOOKED -> IN_SERVICE -> COMPLETED', async () => {
    // 1. Create a DUE service record
    const service = await prisma.serviceRecord.create({
      data: {
        vehicleId: testVehicleId,
        description: 'First cycle maintenance',
        status: 'DUE',
        cycle: 1,
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
      },
    });

    // 2. Assign technician 1
    await prisma.technicianAssignment.create({
      data: {
        serviceRecordId: service.id,
        userId: testTech1Id,
      },
    });

    // 3. Technician cannot book DUE service
    await assert.rejects(
      async () => {
        await updateServiceRecord(
          service.id,
          { id: testTech1Id, role: 'TECHNICIAN' },
          { status: 'BOOKED', dateScheduled: new Date('2026-11-05') }
        );
      },
      (err: any) => err instanceof ForbiddenActionError
    );

    // 4. Fleet Manager books the service
    const scheduledDate = new Date('2026-11-05T09:00:00.000Z');
    const booked = await updateServiceRecord(
      service.id,
      { id: testManagerId, role: 'FLEET_MANAGER' },
      { status: 'BOOKED', dateScheduled: scheduledDate }
    );
    assert.equal(booked.service.status, 'BOOKED');
    assert.equal(booked.service.dateScheduled?.toISOString(), scheduledDate.toISOString());

    // 5. Unassigned Technician 2 cannot start service
    await assert.rejects(
      async () => {
        await updateServiceRecord(
          service.id,
          { id: testTech2Id, role: 'TECHNICIAN' },
          { status: 'IN_SERVICE' }
        );
      },
      (err: any) => err instanceof ForbiddenActionError
    );

    // 6. Assigned Technician 1 starts service
    const inService = await updateServiceRecord(
      service.id,
      { id: testTech1Id, role: 'TECHNICIAN' },
      { status: 'IN_SERVICE', description: 'Work started by Tech 1' }
    );
    assert.equal(inService.service.status, 'IN_SERVICE');

    // 7. Unassigned Technician 2 cannot complete service
    await assert.rejects(
      async () => {
        await updateServiceRecord(
          service.id,
          { id: testTech2Id, role: 'TECHNICIAN' },
          { status: 'COMPLETED', completedOdometer: 52_000 }
        );
      },
      (err: any) => err instanceof ForbiddenActionError
    );

    // 8. Reject completion with lower completedOdometer (rollback test)
    await assert.rejects(
      async () => {
        await updateServiceRecord(
          service.id,
          { id: testTech1Id, role: 'TECHNICIAN' },
          { status: 'COMPLETED', completedOdometer: 49_000 } // Vehicle currently at 50,000
        );
      },
      (err: any) => err instanceof ValidationError
    );

    // Verify rollback: service is still IN_SERVICE and vehicle cycle is still 1
    const serviceAfterFailed = await prisma.serviceRecord.findUnique({ where: { id: service.id } });
    const vehicleAfterFailed = await prisma.vehicle.findUnique({ where: { id: testVehicleId } });
    assert.equal(serviceAfterFailed?.status, 'IN_SERVICE');
    assert.equal(vehicleAfterFailed?.serviceCycle, 1);

    // 9. Assigned Technician 1 completes service with higher odometer (atomic transaction)
    const completedResult = await updateServiceRecord(
      service.id,
      { id: testTech1Id, role: 'TECHNICIAN' },
      {
        status: 'COMPLETED',
        completedOdometer: 52_500,
        description: 'Oil, filters, and brakes replaced',
      }
    );

    // Verify service completion fields
    assert.equal(completedResult.service.status, 'COMPLETED');
    assert.equal(completedResult.service.completedOdometer, 52_500);
    assert.ok(completedResult.service.dateCompleted instanceof Date);

    // Verify vehicle baselines reset and cycle incremented
    assert.equal(completedResult.vehicle.odometer, 52_500);
    assert.equal(completedResult.vehicle.lastServiceMileage, 52_500);
    assert.equal(completedResult.vehicle.serviceCycle, 2); // Incremented from 1 to 2!

    // Verify audit entries created for completion and vehicle baseline reset
    const auditLogs = await prisma.auditLog.findMany({
      where: { serviceRecordId: service.id },
      orderBy: { createdAt: 'asc' },
    });

    const completionLog = auditLogs.find((l) => l.action === 'SERVICE_COMPLETED');
    const baselineLog = auditLogs.find((l) => l.action === 'VEHICLE_BASELINES_RESET');

    assert.ok(completionLog, 'Expected SERVICE_COMPLETED audit log');
    assert.equal(completionLog?.oldValue, 'IN_SERVICE');
    assert.equal(completionLog?.newValue, 'COMPLETED');
    assert.equal(completionLog?.changedById, testTech1Id);

    assert.ok(baselineLog, 'Expected VEHICLE_BASELINES_RESET audit log');
    assert.equal(baselineLog?.field, 'serviceCycle');
    assert.equal(baselineLog?.oldValue, '1');
    assert.equal(baselineLog?.newValue, '2');
  });

  it('Completion with equal odometer succeeds (stationary vehicle maintained)', async () => {
    // Current vehicle odometer is 52,500, cycle is 2
    const service2 = await prisma.serviceRecord.create({
      data: {
        vehicleId: testVehicleId,
        description: 'Cycle 2 maintenance',
        status: 'IN_SERVICE',
        cycle: 2,
      },
    });

    await prisma.technicianAssignment.create({
      data: { serviceRecordId: service2.id, userId: testTech1Id },
    });

    const result = await updateServiceRecord(
      service2.id,
      { id: testTech1Id, role: 'TECHNICIAN' },
      { status: 'COMPLETED', completedOdometer: 52_500 }
    );

    assert.equal(result.service.status, 'COMPLETED');
    assert.equal(result.vehicle.odometer, 52_500);
    assert.equal(result.vehicle.serviceCycle, 3); // Incremented to 3
  });

  describe('Evaluation Integration Rules', () => {
    it('Newly created realistic vehicle is not immediately due', () => {
      const regDate = new Date();
      const evalResult = evaluateServiceDue({
        odometer: 60_000,
        lastServiceDate: regDate,
        lastServiceMileage: 60_000,
        dateIntervalDays: 180,
        mileageInterval: 10_000,
      });

      assert.equal(evalResult.isDue, false);
      assert.equal(evalResult.trigger, 'NONE');
      assert.equal(evalResult.kmRemaining, 10_000);
    });

    it('Mileage threshold creates DUE record with vehicle cycle and dueDate', () => {
      const evalResult = evaluateServiceDue({
        odometer: 70_000, // 60,000 + 10,000 threshold reached
        lastServiceDate: new Date(),
        lastServiceMileage: 60_000,
        dateIntervalDays: 180,
        mileageInterval: 10_000,
      });

      assert.equal(evalResult.isDue, true);
      assert.equal(evalResult.trigger, 'MILEAGE');
      assert.ok(evalResult.canonicalDueDate instanceof Date);
    });

    it('Date threshold creates DUE record with vehicle cycle and dueDate', () => {
      const pastDate = new Date(Date.now() - 200 * 86_400_000); // 200 days ago (> 180)
      const evalResult = evaluateServiceDue({
        odometer: 60_500,
        lastServiceDate: pastDate,
        lastServiceMileage: 60_000,
        dateIntervalDays: 180,
        mileageInterval: 10_000,
      });

      assert.equal(evalResult.isDue, true);
      assert.equal(evalResult.trigger, 'DATE');
      assert.ok(evalResult.canonicalDueDate instanceof Date);
    });
  });

  describe('Service Creation & Assignment Atomicity & Auditing', () => {
    let createdServiceId: string;

    it('1. Manual service creation always creates DUE and sets dueDate to approximately creation time (ignoring caller status and dueDate)', async () => {
      const beforeTime = Date.now() - 2000;
      const res = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({
          vehicleId: testVehicleId,
          description: 'Client trying to bypass lifecycle',
          status: 'COMPLETED', // Caller-provided status must be ignored
          dueDate: '2020-01-01T00:00:00.000Z', // Caller-provided dueDate must be ignored
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      createdServiceId = data.id;

      // 1 & 3: Status is always DUE (caller-supplied COMPLETED ignored)
      assert.equal(data.status, 'DUE');
      const currentVehicle = await prisma.vehicle.findUnique({ where: { id: testVehicleId } });
      assert.equal(data.cycle, currentVehicle?.serviceCycle);

      // 2 & 4: dueDate is approximately creation time (caller-supplied 2020-01-01 ignored)
      const afterTime = Date.now() + 2000;
      const createdDueDateMs = new Date(data.dueDate).getTime();
      assert.ok(
        createdDueDateMs >= beforeTime && createdDueDateMs <= afterTime,
        `dueDate (${data.dueDate}) must be approximately creation time`
      );
      assert.notEqual(data.dueDate, '2020-01-01T00:00:00.000Z');
    });

    it('2. Service creation creates SERVICE_CREATED audit event', async () => {
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          serviceRecordId: createdServiceId,
          action: 'SERVICE_CREATED',
        },
      });

      assert.ok(auditLog, 'Expected SERVICE_CREATED audit log');
      assert.equal(auditLog?.action, 'SERVICE_CREATED');
      assert.equal(auditLog?.field, 'status');
      assert.equal(auditLog?.newValue, 'DUE');
      assert.equal(auditLog?.changedById, testManagerId);
    });

    it('3. Assignment creates TECHNICIAN_ASSIGNED audit event', async () => {
      const res = await fetch(`${baseUrl}/api/services/${createdServiceId}/assignments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({ technicianId: testTech1Id }),
      });

      assert.equal(res.status, 201);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          serviceRecordId: createdServiceId,
          action: 'TECHNICIAN_ASSIGNED',
        },
      });

      assert.ok(auditLog, 'Expected TECHNICIAN_ASSIGNED audit log');
      assert.equal(auditLog?.newValue, testTech1Id);
      assert.equal(auditLog?.changedById, testManagerId);
    });

    it('4. Unassignment creates TECHNICIAN_UNASSIGNED audit event', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/${createdServiceId}/assignments/${testTech1Id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${managerToken}`,
          },
        }
      );

      assert.equal(res.status, 200);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          serviceRecordId: createdServiceId,
          action: 'TECHNICIAN_UNASSIGNED',
        },
      });

      assert.ok(auditLog, 'Expected TECHNICIAN_UNASSIGNED audit log');
      assert.equal(auditLog?.oldValue, testTech1Id);
      assert.equal(auditLog?.newValue, null);
      assert.equal(auditLog?.changedById, testManagerId);
    });

    it('5. Assignment + audit are atomic (failure leaves no partial record)', async () => {
      // Attempt to assign a Fleet Manager (invalid role for technician assignment)
      const res = await fetch(`${baseUrl}/api/services/${createdServiceId}/assignments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({ technicianId: testManagerId }),
      });

      assert.equal(res.status, 400);

      // Verify no assignment was created for manager
      const assignment = await prisma.technicianAssignment.findUnique({
        where: {
          serviceRecordId_userId: {
            serviceRecordId: createdServiceId,
            userId: testManagerId,
          },
        },
      });
      assert.equal(assignment, null);

      // Verify no audit log for failed assignment
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          serviceRecordId: createdServiceId,
          action: 'TECHNICIAN_ASSIGNED',
          newValue: testManagerId,
        },
      });
      assert.equal(auditLog, null);
    });

    it('6. Unassignment + audit are atomic (failure leaves no partial audit log)', async () => {
      // Attempt to unassign a technician who is not assigned
      const res = await fetch(
        `${baseUrl}/api/services/${createdServiceId}/assignments/${testTech2Id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${managerToken}`,
          },
        }
      );

      assert.equal(res.status, 404);

      // Verify no TECHNICIAN_UNASSIGNED audit log for tech2
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          serviceRecordId: createdServiceId,
          action: 'TECHNICIAN_UNASSIGNED',
          oldValue: testTech2Id,
        },
      });
      assert.equal(auditLog, null);
    });

    it('7. Service creation + audit are atomic (failure leaves no orphan audit log)', async () => {
      // Attempt to create service with non-existent vehicleId
      const res = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({
          vehicleId: 'non-existent-vehicle-id-12345',
          description: 'Fail test',
        }),
      });

      assert.equal(res.status, 404);

      // Verify no orphan audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          notes: 'Fail test',
        },
      });
      assert.equal(auditLog, null);
    });

    it('8. Automatic evaluation continues to use the domain-calculated canonical dueDate', async () => {
      // Create a test vehicle that is due by date interval
      const pastDate = new Date(Date.now() - 200 * 86_400_000); // 200 days ago (> 180)
      const evalVehicle = await prisma.vehicle.create({
        data: {
          registration: `AUTO-EVAL-${Date.now()}`,
          make: 'MAN',
          model: 'TGX',
          odometer: 10_000,
          lastServiceMileage: 10_000,
          lastServiceDate: pastDate,
          serviceCycle: 1,
          dismissedAlertCycle: 0,
          dateIntervalDays: 180,
          mileageInterval: 15_000,
        },
      });

      // Calculate expected canonical dueDate from domain function
      const expectedEval = evaluateServiceDue({
        odometer: 10_000,
        lastServiceDate: pastDate,
        lastServiceMileage: 10_000,
        dateIntervalDays: 180,
        mileageInterval: 15_000,
      });

      // Trigger automatic evaluation via POST /api/vehicles/evaluate-status
      const evalRes = await fetch(`${baseUrl}/api/vehicles/evaluate-status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${managerToken}`,
        },
      });
      assert.equal(evalRes.status, 200);

      // Find created record for this vehicle
      const autoRecord = await prisma.serviceRecord.findFirst({
        where: { vehicleId: evalVehicle.id },
      });

      assert.ok(autoRecord, 'Expected automatic service record to be created');
      assert.equal(autoRecord?.status, 'DUE');
      assert.equal(autoRecord?.cycle, 1);
      assert.equal(
        autoRecord?.dueDate?.toISOString(),
        expectedEval.canonicalDueDate?.toISOString()
      );

      // Cleanup
      await prisma.auditLog.deleteMany({ where: { vehicleId: evalVehicle.id } });
      await prisma.serviceRecord.deleteMany({ where: { vehicleId: evalVehicle.id } });
      await prisma.vehicle.delete({ where: { id: evalVehicle.id } });
    });
  });
});
