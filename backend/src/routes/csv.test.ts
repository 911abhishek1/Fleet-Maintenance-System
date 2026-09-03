import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { parse } from 'csv-parse/sync';
import prisma from '../db';
import vehicleRoutes from './vehicles';
import serviceRoutes from './services';

describe('CSV Import & Export Integration Tests', () => {
  const timestamp = Date.now();
  let server: any;
  let baseUrl: string;

  let managerId: string;
  let techId: string;
  let managerToken: string;
  let techToken: string;

  let vehicle1Id: string;
  let vehicle1Reg: string;
  let vehicle2Id: string;
  let vehicle2Reg: string;
  let vehicle3Id: string;
  let vehicle3Reg: string;

  let serviceRecordId: string;
  const complexDescription = 'Brake pads, "front & rear",\ncheck fluid';

  before(async () => {
    // 1. Create Users
    const manager = await prisma.user.create({
      data: {
        email: `csv_mgr_${timestamp}@test.com`,
        passwordHash: 'hash',
        role: 'FLEET_MANAGER',
      },
    });
    managerId = manager.id;

    const tech = await prisma.user.create({
      data: {
        email: `csv_tech_${timestamp}@test.com`,
        passwordHash: 'hash',
        role: 'TECHNICIAN',
      },
    });
    techId = tech.id;

    const jwtSecret = process.env.JWT_SECRET || 'development_secret_key';
    managerToken = jwt.sign({ id: managerId, role: 'FLEET_MANAGER' }, jwtSecret);
    techToken = jwt.sign({ id: techId, role: 'TECHNICIAN' }, jwtSecret);

    // 2. Create Vehicles
    vehicle1Reg = `CSV-V1-${timestamp}`;
    const v1 = await prisma.vehicle.create({
      data: {
        registration: vehicle1Reg,
        make: 'Ford',
        model: 'Transit',
        odometer: 10000,
        lastServiceMileage: 10000,
        lastServiceDate: new Date(),
        serviceCycle: 1,
        dateIntervalDays: 90,
        mileageInterval: 10000,
      },
    });
    vehicle1Id = v1.id;

    vehicle2Reg = `CSV-V2-${timestamp}`;
    const v2 = await prisma.vehicle.create({
      data: {
        registration: vehicle2Reg,
        make: 'Toyota',
        model: 'Hilux',
        odometer: 20000,
        lastServiceMileage: 20000,
        lastServiceDate: new Date(),
        serviceCycle: 1,
        dateIntervalDays: 90,
        mileageInterval: 10000,
      },
    });
    vehicle2Id = v2.id;

    vehicle3Reg = `CSV-V3-${timestamp}`;
    const v3 = await prisma.vehicle.create({
      data: {
        registration: vehicle3Reg,
        make: 'Isuzu',
        model: 'D-Max',
        odometer: 30000,
        lastServiceMileage: 30000,
        lastServiceDate: new Date(),
        serviceCycle: 1,
        dateIntervalDays: 90,
        mileageInterval: 10000,
      },
    });
    vehicle3Id = v3.id;

    // 3. Create Service Record with complex description
    const sr = await prisma.serviceRecord.create({
      data: {
        vehicleId: vehicle1Id,
        description: complexDescription,
        status: 'COMPLETED',
        dateScheduled: new Date('2026-08-01T10:00:00.000Z'),
        dateCompleted: new Date('2026-08-02T15:30:00.000Z'),
        completedOdometer: 10500,
        assignments: { create: { userId: techId } },
      },
    });
    serviceRecordId = sr.id;

    // 4. Setup Express Server
    const app = express();
    app.use(express.json());
    app.use('/api/vehicles', vehicleRoutes);
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
      where: { id: { in: [managerId, techId] } },
    });
  });

  // Helper to upload multipart CSV file
  async function uploadCsv(csvContent: string, token: string = managerToken) {
    const formData = new FormData();
    const blob = new Blob([csvContent], { type: 'text/csv' });
    formData.append('file', blob, 'test.csv');

    return fetch(`${baseUrl}/api/vehicles/bulk-odometer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });
  }

  describe('Bulk Odometer Import Tests', () => {
    it('1. valid CSV with all rows successful', async () => {
      const csv = `registration,odometer\n${vehicle1Reg},11000\n${vehicle2Reg},21000`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 2);
      assert.equal(data.report[0].status, 'SUCCESS');
      assert.equal(data.report[1].status, 'SUCCESS');

      const v1 = await prisma.vehicle.findUnique({ where: { id: vehicle1Id } });
      const v2 = await prisma.vehicle.findUnique({ where: { id: vehicle2Id } });
      assert.equal(v1?.odometer, 11000);
      assert.equal(v2?.odometer, 21000);
    });

    it('2. one invalid row does not prevent valid rows', async () => {
      const csv = `registration,odometer\n${vehicle1Reg},12000\nNON_EXISTENT_VEHICLE,99999\n${vehicle2Reg},22000`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 3);
      assert.equal(data.report[0].status, 'SUCCESS');
      assert.equal(data.report[1].status, 'REJECTED');
      assert.equal(data.report[1].reason, 'Vehicle not found');
      assert.equal(data.report[2].status, 'SUCCESS');

      const v1 = await prisma.vehicle.findUnique({ where: { id: vehicle1Id } });
      const v2 = await prisma.vehicle.findUnique({ where: { id: vehicle2Id } });
      assert.equal(v1?.odometer, 12000);
      assert.equal(v2?.odometer, 22000);
    });

    it('3. lower odometer rejected', async () => {
      // v1 is at 12000
      const csv = `registration,odometer\n${vehicle1Reg},11500`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 1);
      assert.equal(data.report[0].status, 'REJECTED');
      assert.ok(data.report[0].reason.includes('lower'));

      const v1 = await prisma.vehicle.findUnique({ where: { id: vehicle1Id } });
      assert.equal(v1?.odometer, 12000);
    });

    it('4. equal odometer accepted', async () => {
      // v1 is at 12000
      const csv = `registration,odometer\n${vehicle1Reg},12000`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 1);
      assert.equal(data.report[0].status, 'SUCCESS');

      const v1 = await prisma.vehicle.findUnique({ where: { id: vehicle1Id } });
      assert.equal(v1?.odometer, 12000);
    });

    it('5. higher odometer accepted', async () => {
      const csv = `registration,odometer\n${vehicle1Reg},13000`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 1);
      assert.equal(data.report[0].status, 'SUCCESS');

      const v1 = await prisma.vehicle.findUnique({ where: { id: vehicle1Id } });
      assert.equal(v1?.odometer, 13000);
    });

    it('6. unknown vehicle rejected', async () => {
      const csv = `registration,odometer\nUNKNOWN-${timestamp},50000`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 1);
      assert.equal(data.report[0].status, 'REJECTED');
      assert.equal(data.report[0].reason, 'Vehicle not found');
    });

    it('7. malformed CSV rejected', async () => {
      const corruptCsv = `"unclosed quote string\n${vehicle1Reg},50000`;
      const res = await uploadCsv(corruptCsv);
      assert.equal(res.status, 400);

      const data = await res.json();
      assert.ok(data.error.includes('Malformed CSV'));
    });

    it('8. invalid numeric value rejected', async () => {
      const csv = `registration,odometer\n${vehicle1Reg},abc\n${vehicle2Reg},-50\n${vehicle1Reg},12.34`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 3);
      assert.equal(data.report[0].status, 'REJECTED');
      assert.ok(data.report[0].reason.includes('non-negative integer'));
      assert.equal(data.report[1].status, 'REJECTED');
      assert.ok(data.report[1].reason.includes('non-negative integer'));
      assert.equal(data.report[2].status, 'REJECTED');
      assert.ok(data.report[2].reason.includes('non-negative integer'));
    });

    it('9. duplicate vehicle rows behave deterministically', async () => {
      // vehicle 3 starts at 30000
      // row 1: 31000 -> success (odometer becomes 31000)
      // row 2: 30500 -> rejected (lower than 31000)
      // row 3: 32000 -> success (higher than 31000, becomes 32000)
      const csv = `registration,odometer\n${vehicle3Reg},31000\n${vehicle3Reg},30500\n${vehicle3Reg},32000`;
      const res = await uploadCsv(csv);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.report.length, 3);
      assert.equal(data.report[0].status, 'SUCCESS');
      assert.equal(data.report[1].status, 'REJECTED');
      assert.ok(data.report[1].reason.includes('lower than previous recorded'));
      assert.equal(data.report[2].status, 'SUCCESS');

      const v3 = await prisma.vehicle.findUnique({ where: { id: vehicle3Id } });
      assert.equal(v3?.odometer, 32000);
    });

    it('10. Fleet Manager can import', async () => {
      const csv = `registration,odometer\n${vehicle1Reg},14000`;
      const res = await uploadCsv(csv, managerToken);
      assert.equal(res.status, 200);
    });

    it('11. Technician cannot import', async () => {
      const csv = `registration,odometer\n${vehicle1Reg},15000`;
      const res = await uploadCsv(csv, techToken);
      assert.equal(res.status, 403);
    });

    it('12. successful odometer update creates audit event', async () => {
      const csv = `registration,odometer\n${vehicle1Reg},16000`;
      const res = await uploadCsv(csv, managerToken);
      assert.equal(res.status, 200);

      const auditEvent = await prisma.auditLog.findFirst({
        where: {
          vehicleId: vehicle1Id,
          action: 'ODOMETER_UPDATED',
          newValue: '16000',
        },
      });

      assert.ok(auditEvent);
      assert.equal(auditEvent.changedById, managerId);
      assert.equal(auditEvent.field, 'odometer');
    });

    it('13. rejected row does not create update audit event', async () => {
      // Clear audit logs on vehicle 2
      await prisma.auditLog.deleteMany({ where: { vehicleId: vehicle2Id } });

      // Attempt rejected update (v2 is at 22000, attempt 21000)
      const csv = `registration,odometer\n${vehicle2Reg},21000`;
      const res = await uploadCsv(csv, managerToken);
      assert.equal(res.status, 200);

      const count = await prisma.auditLog.count({
        where: { vehicleId: vehicle2Id },
      });
      assert.equal(count, 0, 'No audit events should be created for rejected rows');
    });
  });

  describe('Service History CSV Export Tests', () => {
    it('14. export contains expected service-history fields', async () => {
      const res = await fetch(`${baseUrl}/api/services/export-csv`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type')?.includes('text/csv'), true);

      const csvText = await res.text();
      const parsed = parse(csvText, { skip_empty_lines: true });
      const headers = parsed[0];

      assert.ok(headers.includes('Service ID'));
      assert.ok(headers.includes('Vehicle Registration'));
      assert.ok(headers.includes('Description'));
      assert.ok(headers.includes('Status'));
      assert.ok(headers.includes('Date Scheduled'));
      assert.ok(headers.includes('Date Completed'));
      assert.ok(headers.includes('Completed Odometer'));
      assert.ok(headers.includes('Technicians'));
    });

    it('15. CSV escaping works for descriptions containing commas/quotes/newlines', async () => {
      const res = await fetch(`${baseUrl}/api/services/export-csv`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(res.status, 200);

      const csvText = await res.text();
      const parsed: string[][] = parse(csvText, { skip_empty_lines: true });

      // Find our complex record
      const recordRow = parsed.find((row) => row[0] === serviceRecordId);
      assert.ok(recordRow, 'Service record row should be present in CSV');

      // Description is at column index 2
      assert.equal(recordRow[2], complexDescription);
      assert.equal(recordRow[1], vehicle1Reg);
      assert.equal(recordRow[3], 'COMPLETED');
      assert.equal(recordRow[6], '10500');
    });
  });
});
