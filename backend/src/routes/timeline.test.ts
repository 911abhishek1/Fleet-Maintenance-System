import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import serviceRoutes from './services';

describe('Service Audit Timeline Integration Tests', () => {
  const ts = Date.now();
  let server: any;
  let baseUrl: string;

  let managerId: string;
  let assignedTechId: string;
  let unassignedTechId: string;

  let managerToken: string;
  let assignedTechToken: string;
  let unassignedTechToken: string;

  let vehicleId: string;
  let serviceId: string;

  before(async () => {
    // 1. Create Users
    const manager = await prisma.user.create({
      data: {
        email: `time_mgr_${ts}@test.com`,
        passwordHash: 'secret_hash_value',
        role: 'FLEET_MANAGER',
      },
    });
    managerId = manager.id;

    const assignedTech = await prisma.user.create({
      data: {
        email: `time_tech1_${ts}@test.com`,
        passwordHash: 'secret_hash_value',
        role: 'TECHNICIAN',
      },
    });
    assignedTechId = assignedTech.id;

    const unassignedTech = await prisma.user.create({
      data: {
        email: `time_tech2_${ts}@test.com`,
        passwordHash: 'secret_hash_value',
        role: 'TECHNICIAN',
      },
    });
    unassignedTechId = unassignedTech.id;

    const jwtSecret = process.env.JWT_SECRET || 'development_secret_key';
    managerToken = jwt.sign({ id: managerId, role: 'FLEET_MANAGER' }, jwtSecret);
    assignedTechToken = jwt.sign({ id: assignedTechId, role: 'TECHNICIAN' }, jwtSecret);
    unassignedTechToken = jwt.sign({ id: unassignedTechId, role: 'TECHNICIAN' }, jwtSecret);

    // 2. Create Vehicle
    const v = await prisma.vehicle.create({
      data: {
        registration: `REG-TIME-${ts}`,
        make: 'Scania',
        model: 'R500',
        odometer: 40000,
        lastServiceMileage: 40000,
        lastServiceDate: new Date('2026-01-01'),
        serviceCycle: 1,
        dateIntervalDays: 180,
        mileageInterval: 15000,
      },
    });
    vehicleId = v.id;

    // 3. Start Express server
    const app = express();
    app.use(express.json());
    app.use('/api/services', serviceRoutes);
    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as any).port}`;
  });

  after(async () => {
    if (server) server.close();

    // Clean up
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { changedById: { in: [managerId, assignedTechId, unassignedTechId] } },
          { vehicleId: vehicleId },
        ],
      },
    });
    await prisma.technicianAssignment.deleteMany({
      where: { userId: { in: [assignedTechId, unassignedTechId] } },
    });
    await prisma.serviceRecord.deleteMany({
      where: { vehicleId: vehicleId },
    });
    await prisma.vehicle.deleteMany({
      where: { id: vehicleId },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [managerId, assignedTechId, unassignedTechId] } },
    });
  });

  it('1. Lifecycle events generate audit log entries', async () => {
    // 1a. Manager creates service (SERVICE_CREATED)
    const createRes = await fetch(`${baseUrl}/api/services`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({
        vehicleId,
        description: 'Brake pad and hydraulic system inspection',
      }),
    });
    assert.equal(createRes.status, 201);
    const service = await createRes.json();
    serviceId = service.id;

    // 1b. Manager assigns technician (TECHNICIAN_ASSIGNED)
    const assignRes = await fetch(`${baseUrl}/api/services/${serviceId}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ technicianId: assignedTechId }),
    });
    assert.equal(assignRes.status, 201);

    // 1c. Manager books service (SERVICE_BOOKED)
    const bookRes = await fetch(`${baseUrl}/api/services/${serviceId}`, {
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

    // 1d. Assigned tech updates work description (SERVICE_UPDATED)
    const updateRes = await fetch(`${baseUrl}/api/services/${serviceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({
        description: 'Brake pads and calipers verified; hydraulic lines inspected',
      }),
    });
    assert.equal(updateRes.status, 200);

    // 1e. Assigned tech starts work (SERVICE_STARTED)
    const startRes = await fetch(`${baseUrl}/api/services/${serviceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({ status: 'IN_SERVICE' }),
    });
    assert.equal(startRes.status, 200);

    // 1f. Assigned tech completes work (SERVICE_COMPLETED)
    const completeRes = await fetch(`${baseUrl}/api/services/${serviceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({
        status: 'COMPLETED',
        completedOdometer: 40500,
      }),
    });
    assert.equal(completeRes.status, 200);
  });

  it('2. Manager can retrieve service timeline in chronological order', async () => {
    const res = await fetch(`${baseUrl}/api/services/${serviceId}/timeline`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });

    assert.equal(res.status, 200);
    const timeline = await res.json();
    assert.ok(Array.isArray(timeline));
    assert.ok(timeline.length >= 6, `Expected at least 6 events, got ${timeline.length}`);

    // Verify chronological order (createdAt ascending)
    for (let i = 1; i < timeline.length; i++) {
      const prev = new Date(timeline[i - 1].createdAt).getTime();
      const curr = new Date(timeline[i].createdAt).getTime();
      assert.ok(curr >= prev, 'Timeline must be ordered chronologically ascending');
    }

    // Verify presence of all expected actions
    const actions = timeline.map((e: any) => e.action);
    assert.ok(actions.includes('SERVICE_CREATED'));
    assert.ok(actions.includes('TECHNICIAN_ASSIGNED'));
    assert.ok(actions.includes('SERVICE_BOOKED'));
    assert.ok(actions.includes('SERVICE_UPDATED'));
    assert.ok(actions.includes('SERVICE_STARTED'));
    assert.ok(actions.includes('SERVICE_COMPLETED'));
  });

  it('3. Timeline entries include actor details and NEVER expose passwordHash', async () => {
    const res = await fetch(`${baseUrl}/api/services/${serviceId}/timeline`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });

    assert.equal(res.status, 200);
    const timeline = await res.json();

    for (const entry of timeline) {
      assert.ok(entry.id);
      assert.ok(entry.action);
      assert.ok(entry.createdAt);

      if (entry.changedBy) {
        assert.ok(entry.changedBy.id);
        assert.ok(entry.changedBy.email);
        assert.ok(entry.changedBy.role);
        // Security requirement: never expose passwordHash
        assert.equal(entry.changedBy.passwordHash, undefined);
        assert.equal(entry.changedBy.password, undefined);
      }
    }
  });

  it('4. Assigned Technician can retrieve timeline for assigned service', async () => {
    const res = await fetch(`${baseUrl}/api/services/${serviceId}/timeline`, {
      headers: { Authorization: `Bearer ${assignedTechToken}` },
    });

    assert.equal(res.status, 200);
    const timeline = await res.json();
    assert.ok(Array.isArray(timeline));
    assert.ok(timeline.length >= 6);
  });

  it('5. Unassigned Technician is rejected with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/services/${serviceId}/timeline`, {
      headers: { Authorization: `Bearer ${unassignedTechToken}` },
    });

    assert.equal(res.status, 403);
    const err = await res.json();
    assert.match(err.error, /not assigned/i);
  });

  it('6. Non-existent service returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/services/00000000-0000-0000-0000-000000000000/timeline`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });

    assert.equal(res.status, 404);
  });

  it('7. No endpoints exist to modify or delete audit timeline', async () => {
    // Attempt PUT
    const putRes = await fetch(`${baseUrl}/api/services/${serviceId}/timeline`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ action: 'TAMPER' }),
    });
    assert.ok([404, 405].includes(putRes.status));

    // Attempt DELETE
    const delRes = await fetch(`${baseUrl}/api/services/${serviceId}/timeline`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    assert.ok([404, 405].includes(delRes.status));
  });
});
