import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import serviceRoutes from './services';
import vehicleRoutes from './vehicles';

describe('Service Creation & Assignment Workflow Regression Tests', () => {
  const ts = Date.now();
  let server: any;
  let baseUrl: string;

  let managerId: string;
  let tech1Id: string;
  let tech2Id: string;
  let nonTechManagerId: string;

  let managerToken: string;
  let tech1Token: string;
  let tech2Token: string;

  let vehicleId: string;
  let service1Id: string;
  let service2Id: string;

  before(async () => {
    // 1. Create Users
    const manager = await prisma.user.create({
      data: {
        email: `wf_mgr_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'FLEET_MANAGER',
      },
    });
    managerId = manager.id;

    const nonTechManager = await prisma.user.create({
      data: {
        email: `wf_nontech_mgr_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'FLEET_MANAGER',
      },
    });
    nonTechManagerId = nonTechManager.id;

    const tech1 = await prisma.user.create({
      data: {
        email: `wf_tech1_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'TECHNICIAN',
      },
    });
    tech1Id = tech1.id;

    const tech2 = await prisma.user.create({
      data: {
        email: `wf_tech2_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'TECHNICIAN',
      },
    });
    tech2Id = tech2.id;

    const jwtSecret = process.env.JWT_SECRET || 'supersecretkey';
    managerToken = jwt.sign({ id: managerId, role: 'FLEET_MANAGER' }, jwtSecret);
    tech1Token = jwt.sign({ id: tech1Id, role: 'TECHNICIAN' }, jwtSecret);
    tech2Token = jwt.sign({ id: tech2Id, role: 'TECHNICIAN' }, jwtSecret);

    // 2. Create Vehicle
    const v = await prisma.vehicle.create({
      data: {
        registration: `REG-WF-${ts}`,
        make: 'Isuzu',
        model: 'D-Max',
        odometer: 30000,
        lastServiceMileage: 30000,
        lastServiceDate: new Date('2026-01-01'),
        serviceCycle: 1,
        dateIntervalDays: 180,
        mileageInterval: 10000,
        archived: false,
      },
    });
    vehicleId = v.id;

    // 3. Start Express server
    const app = express();
    app.use(express.json());
    app.use('/api/services', serviceRoutes);
    app.use('/api/vehicles', vehicleRoutes);
    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as any).port}`;
  });

  after(async () => {
    if (server) server.close();

    // Clean up
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { changedById: { in: [managerId, tech1Id, tech2Id, nonTechManagerId] } },
          { vehicleId: vehicleId },
        ],
      },
    });
    await prisma.technicianAssignment.deleteMany({
      where: { userId: { in: [tech1Id, tech2Id, nonTechManagerId] } },
    });
    await prisma.serviceRecord.deleteMany({
      where: { vehicleId: vehicleId },
    });
    await prisma.vehicle.deleteMany({
      where: { id: vehicleId },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [managerId, tech1Id, tech2Id, nonTechManagerId] } },
    });
  });

  // 1. Technician POST /api/services -> 403
  it('1. Technician POST /api/services returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/services`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tech1Token}`,
      },
      body: JSON.stringify({
        vehicleId,
        description: 'Illegal technician created service',
      }),
    });
    assert.equal(res.status, 403);
  });

  // 7. Manager can create service
  it('7. Manager can create service starting in DUE with canonical cycle', async () => {
    const res = await fetch(`${baseUrl}/api/services`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({
        vehicleId,
        description: 'Brake inspection and replacement',
        status: 'COMPLETED', // attempt override
        cycle: 99, // attempt override
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'DUE', 'Must always initialize in DUE status');
    assert.equal(body.cycle, 1, 'Must bind to vehicle current cycle');
    assert.ok(body.dueDate, 'Must populate dueDate');
    service1Id = body.id;
  });

  // 2. Technician assignment -> 403
  it('2. Technician assignment returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tech1Token}`,
      },
      body: JSON.stringify({ technicianId: tech1Id }),
    });
    assert.equal(res.status, 403);
  });

  // 8. Manager can assign technician
  it('8. Manager can assign technician', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ technicianId: tech1Id }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.userId, tech1Id);

    // Verify audit log
    const audit = await prisma.auditLog.findFirst({
      where: { serviceRecordId: service1Id, action: 'TECHNICIAN_ASSIGNED' },
    });
    assert.ok(audit, 'TECHNICIAN_ASSIGNED audit event must be created');
  });

  // 10. Duplicate assignment rejected
  it('10. Duplicate assignment is rejected with 400', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ technicianId: tech1Id }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('already assigned'));
  });

  // Assignment validation: Cannot assign Fleet Manager
  it('Assigning a user with role FLEET_MANAGER is rejected with 400', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ technicianId: nonTechManagerId }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('Only users with role "TECHNICIAN" can be assigned'));
  });

  // 9. Multiple technicians can be assigned
  it('9. Multiple technicians can be assigned to one service', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ technicianId: tech2Id }),
    });
    assert.equal(res.status, 201);

    const assignments = await prisma.technicianAssignment.findMany({
      where: { serviceRecordId: service1Id },
    });
    assert.equal(assignments.length, 2, 'Should have 2 assigned technicians');
  });

  // 3. Technician unassignment -> 403
  it('3. Technician unassignment returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/assignments/${tech2Id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${tech1Token}`,
      },
    });
    assert.equal(res.status, 403);
  });

  // Manager unassigns Tech2
  it('Manager can unassign technician', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/assignments/${tech2Id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${managerToken}`,
      },
    });
    assert.equal(res.status, 200);

    const assignments = await prisma.technicianAssignment.findMany({
      where: { serviceRecordId: service1Id },
    });
    assert.equal(assignments.length, 1, 'Should have 1 assigned technician left (tech1)');
    assert.equal(assignments[0].userId, tech1Id);
  });

  // 4. Technician cannot modify assignment via service update
  it('4. Technician cannot modify assignment or arbitrary fields via service update', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tech1Token}`,
      },
      body: JSON.stringify({
        description: 'Updated work description by tech1',
        technicianId: tech2Id,
        assignments: [{ userId: tech2Id }],
        vehicleId: 'bogus',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.description, 'Updated work description by tech1');

    // Verify assignments still only tech1
    const assignments = await prisma.technicianAssignment.findMany({
      where: { serviceRecordId: service1Id },
    });
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].userId, tech1Id);
  });

  // 5. Technician cannot access an unassigned service by ID
  it('5. Technician cannot access an unassigned service by ID (returns 403)', async () => {
    // service1 is assigned ONLY to tech1. Tech2 is unassigned.
    const res = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      headers: {
        Authorization: `Bearer ${tech2Token}`,
      },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.includes('not assigned'));
  });

  it('Assigned technician and Manager can access service by ID (returns 200)', async () => {
    const techRes = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      headers: { Authorization: `Bearer ${tech1Token}` },
    });
    assert.equal(techRes.status, 200);

    const mgrRes = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    assert.equal(mgrRes.status, 200);
  });

  // 6. Technician search remains server-side scoped
  it('6. Technician search remains server-side scoped', async () => {
    // Create service2 assigned to tech2
    const s2 = await prisma.serviceRecord.create({
      data: {
        vehicleId,
        description: 'Service for tech2 only',
        status: 'DUE',
        assignments: { create: { userId: tech2Id } },
      },
    });
    service2Id = s2.id;

    // Tech1 searches
    const tech1Res = await fetch(`${baseUrl}/api/services/search`, {
      headers: { Authorization: `Bearer ${tech1Token}` },
    });
    assert.equal(tech1Res.status, 200);
    const tech1Body = await tech1Res.json();
    assert.ok(tech1Body.records.some((r: any) => r.id === service1Id));
    assert.ok(!tech1Body.records.some((r: any) => r.id === service2Id));

    // Tech1 tries to supply ?technicianId=tech2Id to bypass
    const bypassRes = await fetch(`${baseUrl}/api/services/search?technicianId=${tech2Id}`, {
      headers: { Authorization: `Bearer ${tech1Token}` },
    });
    assert.equal(bypassRes.status, 200);
    const bypassBody = await bypassRes.json();
    assert.ok(!bypassBody.records.some((r: any) => r.id === service2Id), 'Server must ignore query param for tech');
  });

  // 11 & 12: Assigned vs Unassigned technician lifecycle actions
  it('11 & 12. Assigned technician can perform permitted lifecycle actions; unassigned is rejected', async () => {
    // Book service1 (manager only)
    const bookRes = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({
        status: 'BOOKED',
        dateScheduled: new Date(Date.now() + 86400000).toISOString(),
      }),
    });
    assert.equal(bookRes.status, 200);

    // Unassigned tech2 tries to start service1 -> 403
    const tech2Start = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tech2Token}`,
      },
      body: JSON.stringify({ status: 'IN_SERVICE' }),
    });
    assert.equal(tech2Start.status, 403);

    // Assigned tech1 starts service1 -> 200
    const tech1Start = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tech1Token}`,
      },
      body: JSON.stringify({ status: 'IN_SERVICE' }),
    });
    assert.equal(tech1Start.status, 200);

    // Unassigned tech2 tries to complete service1 -> 403
    const tech2Complete = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tech2Token}`,
      },
      body: JSON.stringify({ status: 'COMPLETED', completedOdometer: 31000 }),
    });
    assert.equal(tech2Complete.status, 403);

    // Assigned tech1 completes service1 -> 200
    const tech1Complete = await fetch(`${baseUrl}/api/services/${service1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tech1Token}`,
      },
      body: JSON.stringify({ status: 'COMPLETED', completedOdometer: 31000 }),
    });
    assert.equal(tech1Complete.status, 200);
    const completedBody = await tech1Complete.json();
    assert.equal(completedBody.status, 'COMPLETED');
    assert.equal(completedBody.completedOdometer, 31000);
  });
});
