import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import serviceRoutes from './services';
import vehicleRoutes from './vehicles';

describe('Server-Side Querying, Filtering & Pagination Tests', () => {
  const timestamp = Date.now();
  let server: any;
  let baseUrl: string;

  let managerId: string;
  let tech1Id: string;
  let tech2Id: string;

  let managerToken: string;
  let tech1Token: string;
  let tech2Token: string;

  let vehicleAId: string;
  let vehicleBId: string;
  let vehicleCId: string; // archived

  let record1Id: string;
  let record2Id: string;
  let record3Id: string;
  let record4Id: string;

  before(async () => {
    // 1. Create Users
    const manager = await prisma.user.create({
      data: {
        email: `query_manager_${timestamp}@test.com`,
        passwordHash: 'testhash',
        role: 'FLEET_MANAGER',
      },
    });
    managerId = manager.id;

    const tech1 = await prisma.user.create({
      data: {
        email: `query_tech1_${timestamp}@test.com`,
        passwordHash: 'testhash',
        role: 'TECHNICIAN',
      },
    });
    tech1Id = tech1.id;

    const tech2 = await prisma.user.create({
      data: {
        email: `query_tech2_${timestamp}@test.com`,
        passwordHash: 'testhash',
        role: 'TECHNICIAN',
      },
    });
    tech2Id = tech2.id;

    // Tokens
    const jwtSecret = process.env.JWT_SECRET || 'supersecretkey';
    managerToken = jwt.sign({ id: managerId, role: 'FLEET_MANAGER' }, jwtSecret);
    tech1Token = jwt.sign({ id: tech1Id, role: 'TECHNICIAN' }, jwtSecret);
    tech2Token = jwt.sign({ id: tech2Id, role: 'TECHNICIAN' }, jwtSecret);

    // 2. Create Vehicles
    const vA = await prisma.vehicle.create({
      data: {
        registration: `REG-A-${timestamp}`,
        make: 'Volvo',
        model: 'FH16',
        odometer: 100_000,
        lastServiceMileage: 100_000,
        lastServiceDate: new Date('2026-01-01'),
        serviceCycle: 1,
        dateIntervalDays: 180,
        mileageInterval: 20_000,
        archived: false,
      },
    });
    vehicleAId = vA.id;

    const vB = await prisma.vehicle.create({
      data: {
        registration: `REG-B-${timestamp}`,
        make: 'Scania',
        model: 'R500',
        odometer: 150_000,
        lastServiceMileage: 150_000,
        lastServiceDate: new Date('2026-02-01'),
        serviceCycle: 1,
        dateIntervalDays: 180,
        mileageInterval: 20_000,
        archived: false,
      },
    });
    vehicleBId = vB.id;

    const vC = await prisma.vehicle.create({
      data: {
        registration: `REG-C-${timestamp}`,
        make: 'Mercedes',
        model: 'Actros',
        odometer: 200_000,
        lastServiceMileage: 200_000,
        lastServiceDate: new Date('2026-03-01'),
        serviceCycle: 1,
        dateIntervalDays: 180,
        mileageInterval: 20_000,
        archived: true, // Archived
      },
    });
    vehicleCId = vC.id;

    // 3. Create Service Records
    // Record 1: vehicle A, "Engine oil replacement", DUE, dateScheduled: 2026-09-10, assigned to tech1
    const r1 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicleAId,
        description: 'Engine oil replacement',
        status: 'DUE',
        dateScheduled: new Date('2026-09-10T10:00:00.000Z'),
        assignments: { create: { userId: tech1Id } },
      },
    });
    record1Id = r1.id;

    // Record 2: vehicle A, "Brake pad inspection", BOOKED, dateScheduled: 2026-09-15, assigned to tech2
    const r2 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicleAId,
        description: 'Brake pad inspection',
        status: 'BOOKED',
        dateScheduled: new Date('2026-09-15T10:00:00.000Z'),
        assignments: { create: { userId: tech2Id } },
      },
    });
    record2Id = r2.id;

    // Record 3: vehicle B, "Transmission fluid check", IN_SERVICE, dateScheduled: 2026-09-20, assigned to tech1
    const r3 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicleBId,
        description: 'Transmission fluid check',
        status: 'IN_SERVICE',
        dateScheduled: new Date('2026-09-20T10:00:00.000Z'),
        assignments: { create: { userId: tech1Id } },
      },
    });
    record3Id = r3.id;

    // Record 4: vehicle B, "Coolant flush service", COMPLETED, dateScheduled: 2026-09-05, unassigned
    const r4 = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicleBId,
        description: 'Coolant flush service',
        status: 'COMPLETED',
        dateScheduled: new Date('2026-09-05T10:00:00.000Z'),
      },
    });
    record4Id = r4.id;

    // 4. Start HTTP test harness
    const app = express();
    app.use(express.json());
    app.use('/api/services', serviceRoutes);
    app.use('/api/vehicles', vehicleRoutes);
    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as any).port}`;
  });

  after(async () => {
    if (server) server.close();
    // Cleanup
    await prisma.technicianAssignment.deleteMany({
      where: {
        serviceRecord: { vehicleId: { in: [vehicleAId, vehicleBId, vehicleCId] } },
      },
    });
    await prisma.auditLog.deleteMany({
      where: {
        vehicleId: { in: [vehicleAId, vehicleBId, vehicleCId] },
      },
    });
    await prisma.serviceRecord.deleteMany({
      where: { vehicleId: { in: [vehicleAId, vehicleBId, vehicleCId] } },
    });
    await prisma.vehicle.deleteMany({
      where: { id: { in: [vehicleAId, vehicleBId, vehicleCId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [managerId, tech1Id, tech2Id] } },
    });
  });

  describe('Service Search Tests', () => {
    it('1. Manager sees fleet-wide results', async () => {
      const res = await fetch(`${baseUrl}/api/services/search?limit=100`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const testIds = [record1Id, record2Id, record3Id, record4Id];
      const matching = data.records.filter((r: any) => testIds.includes(r.id));
      assert.equal(matching.length, 4);
    });

    it('2. Technician sees only assigned records', async () => {
      const res = await fetch(`${baseUrl}/api/services/search?limit=100`, {
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const testIds = [record1Id, record2Id, record3Id, record4Id];
      const matching = data.records.filter((r: any) => testIds.includes(r.id));
      assert.equal(matching.length, 2);
      const matchedIds = matching.map((r: any) => r.id);
      assert.ok(matchedIds.includes(record1Id));
      assert.ok(matchedIds.includes(record3Id));
      assert.ok(!matchedIds.includes(record2Id));
      assert.ok(!matchedIds.includes(record4Id));
    });

    it('3. Technician cannot bypass scope by supplying another technicianId', async () => {
      // Tech 1 attempts to pass Tech 2's id in query
      const res = await fetch(`${baseUrl}/api/services/search?technicianId=${tech2Id}`, {
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const testIds = [record1Id, record2Id, record3Id, record4Id];
      const matching = data.records.filter((r: any) => testIds.includes(r.id));
      // Still only receives tech1's assigned records!
      assert.equal(matching.length, 2);
      assert.ok(!matching.some((r: any) => r.id === record2Id));
    });

    it('4. Search by description', async () => {
      const res = await fetch(`${baseUrl}/api/services/search?description=oil`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.records.some((r: any) => r.id === record1Id));
      assert.ok(!data.records.some((r: any) => r.id === record2Id));
    });

    it('5. Filter by vehicle', async () => {
      const res = await fetch(`${baseUrl}/api/services/search?vehicleId=${vehicleAId}`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.total, 2);
      const ids = data.records.map((r: any) => r.id);
      assert.ok(ids.includes(record1Id));
      assert.ok(ids.includes(record2Id));
    });

    it('6. Filter by status', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/search?vehicleId=${vehicleAId}&status=BOOKED`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.total, 1);
      assert.equal(data.records[0].id, record2Id);
    });

    it('7. Filter by technician', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/search?vehicleId=${vehicleAId}&technicianId=${tech2Id}`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.total, 1);
      assert.equal(data.records[0].id, record2Id);
    });

    it('8. Combined filters', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/search?vehicleId=${vehicleAId}&status=DUE&description=Engine`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.total, 1);
      assert.equal(data.records[0].id, record1Id);
    });

    it('9. Sort by allowed field ascending', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/search?vehicleId=${vehicleAId}&sortBy=dateScheduled&sortOrder=asc`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.records.length, 2);
      assert.equal(data.records[0].id, record1Id); // Sept 10
      assert.equal(data.records[1].id, record2Id); // Sept 15
    });

    it('10. Sort by allowed field descending', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/search?vehicleId=${vehicleAId}&sortBy=dateScheduled&sortOrder=desc`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.records.length, 2);
      assert.equal(data.records[0].id, record2Id); // Sept 15
      assert.equal(data.records[1].id, record1Id); // Sept 10
    });

    it('11. Invalid sort field returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/services/search?sortBy=maliciousColumn`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('Invalid sort field'));
    });

    it('12. Invalid sort order returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/services/search?sortOrder=sideways`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('Invalid sort order'));
    });

    it('13. Invalid page returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/services/search?page=0`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('Invalid page'));
    });

    it('14. Invalid/too-large limit returns 400', async () => {
      const res1 = await fetch(`${baseUrl}/api/services/search?limit=0`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res1.status, 400);

      const res2 = await fetch(`${baseUrl}/api/services/search?limit=101`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res2.status, 400);
    });

    it('15. Pagination total is correct', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/search?vehicleId=${vehicleAId}&page=1&limit=1`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.records.length, 1);
      assert.equal(data.total, 2);
    });

    it('16. totalPages is correct', async () => {
      const res = await fetch(
        `${baseUrl}/api/services/search?vehicleId=${vehicleAId}&page=1&limit=1`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.totalPages, 2);
    });
  });

  describe('Vehicle Listing Tests', () => {
    it('1. Search by registration', async () => {
      const res = await fetch(`${baseUrl}/api/vehicles?search=REG-A-${timestamp}`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.total, 1);
      assert.equal(data.vehicles[0].id, vehicleAId);
    });

    it('2. Search by make/model', async () => {
      const res = await fetch(`${baseUrl}/api/vehicles?search=Scania`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.vehicles.some((v: any) => v.id === vehicleBId));
    });

    it('3. Archived vehicles excluded by default', async () => {
      const res = await fetch(`${baseUrl}/api/vehicles?search=${timestamp}`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const ids = data.vehicles.map((v: any) => v.id);
      assert.ok(ids.includes(vehicleAId));
      assert.ok(ids.includes(vehicleBId));
      assert.ok(!ids.includes(vehicleCId), 'Archived vehicle C should be excluded by default');
    });

    it('4. Explicit archived filter works', async () => {
      const res = await fetch(`${baseUrl}/api/vehicles?search=${timestamp}&archived=true`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const ids = data.vehicles.map((v: any) => v.id);
      assert.ok(ids.includes(vehicleCId), 'Archived vehicle C should be returned');
      assert.ok(!ids.includes(vehicleAId));
      assert.ok(!ids.includes(vehicleBId));
    });

    it('5. Pagination works', async () => {
      const res = await fetch(`${baseUrl}/api/vehicles?search=${timestamp}&page=1&limit=1`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.vehicles.length, 1);
      assert.equal(data.total, 2);
      assert.equal(data.totalPages, 2);
    });

    it('6. Invalid sort field rejected', async () => {
      const res = await fetch(`${baseUrl}/api/vehicles?sortBy=injectedColumn`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('Invalid sort field'));
    });

    it('7. Technician access to fleet vehicle listing is rejected with 403', async () => {
      const res = await fetch(`${baseUrl}/api/vehicles`, {
        headers: { Authorization: `Bearer ${tech1Token}` },
      });
      assert.equal(res.status, 403);
    });
  });
});
