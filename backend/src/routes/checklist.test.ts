import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import serviceRoutes from './services';

describe('Vehicle Inspection Checklists Integration Tests', () => {
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
  let service1Id: string;
  let service2Id: string;
  let completedServiceId: string;

  let createdItemId: string;

  before(async () => {
    // 1. Create Users
    const manager = await prisma.user.create({
      data: {
        email: `chk_mgr_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'FLEET_MANAGER',
      },
    });
    managerId = manager.id;

    const assignedTech = await prisma.user.create({
      data: {
        email: `chk_tech1_${ts}@test.com`,
        passwordHash: 'hash',
        role: 'TECHNICIAN',
      },
    });
    assignedTechId = assignedTech.id;

    const unassignedTech = await prisma.user.create({
      data: {
        email: `chk_tech2_${ts}@test.com`,
        passwordHash: 'hash',
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
        registration: `REG-CHK-${ts}`,
        make: 'Volvo',
        model: 'FH16',
        odometer: 50000,
        lastServiceMileage: 50000,
        lastServiceDate: new Date('2026-01-01'),
        serviceCycle: 1,
        dateIntervalDays: 180,
        mileageInterval: 10000,
        archived: false,
      },
    });
    vehicleId = v.id;

    // 3. Create Service 1 (DUE) with assignedTech
    const s1 = await prisma.serviceRecord.create({
      data: {
        vehicleId,
        description: 'Brake and tire inspection',
        status: 'DUE',
        cycle: 1,
        dueDate: new Date(),
      },
    });
    service1Id = s1.id;

    await prisma.technicianAssignment.create({
      data: {
        serviceRecordId: service1Id,
        userId: assignedTechId,
      },
    });

    // 4. Create Service 2 (DUE) assigned to NO ONE (or unassigned for tech1)
    const s2 = await prisma.serviceRecord.create({
      data: {
        vehicleId,
        description: 'Secondary service',
        status: 'DUE',
        cycle: 1,
        dueDate: new Date(),
      },
    });
    service2Id = s2.id;

    // 5. Create Completed Service
    const sComp = await prisma.serviceRecord.create({
      data: {
        vehicleId,
        description: 'Completed legacy inspection',
        status: 'COMPLETED',
        cycle: 1,
        dueDate: new Date('2026-01-01'),
        dateCompleted: new Date('2026-01-02'),
        completedOdometer: 50000,
      },
    });
    completedServiceId = sComp.id;
    await prisma.technicianAssignment.create({
      data: {
        serviceRecordId: completedServiceId,
        userId: assignedTechId,
      },
    });

    // 6. Start server
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
    await prisma.inspectionChecklistItem.deleteMany({
      where: { serviceRecordId: { in: [service1Id, service2Id, completedServiceId] } },
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

  // Test 1: Manager creates checklist item
  it('1. Manager creates checklist item successfully', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({
        title: 'Brake Pad Thickness',
        description: 'Measure front and rear pads (min 3mm)',
        required: true,
      }),
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.equal(data.serviceRecordId, service1Id);
    assert.equal(data.title, 'Brake Pad Thickness');
    assert.equal(data.description, 'Measure front and rear pads (min 3mm)');
    assert.equal(data.required, true);
    assert.equal(data.result, 'PENDING');
    createdItemId = data.id;
  });

  // Test 2: Technician assigned to service can read checklist
  it('2. Technician assigned to service can read checklist', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      headers: { Authorization: `Bearer ${assignedTechToken}` },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].id, createdItemId);
    assert.equal(data[0].title, 'Brake Pad Thickness');
  });

  // Test 3: Technician can update checklist result
  it('3. Technician can update checklist result', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${createdItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({
        result: 'PASS',
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.result, 'PASS');
    assert.equal(data.checkedById, assignedTechId);
  });

  // Test 4: Technician can add/update permitted notes
  it('4. Technician can add/update permitted notes', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${createdItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({
        notes: 'Front pads 6mm, rear pads 5mm. All within tolerance.',
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.notes, 'Front pads 6mm, rear pads 5mm. All within tolerance.');
    assert.equal(data.result, 'PASS'); // Result preserved
  });

  // Test 5: Unassigned technician gets 403
  it('5. Unassigned technician gets 403 on GET and PUT', async () => {
    // Attempt GET
    const getRes = await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      headers: { Authorization: `Bearer ${unassignedTechToken}` },
    });
    assert.equal(getRes.status, 403);
    const getErr = await getRes.json();
    assert.match(getErr.error, /not assigned/i);

    // Attempt PUT
    const putRes = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${createdItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${unassignedTechToken}`,
      },
      body: JSON.stringify({ result: 'FAIL' }),
    });
    assert.equal(putRes.status, 403);
    const putErr = await putRes.json();
    assert.match(putErr.error, /not assigned/i);
  });

  // Test 6: Technician cannot modify assignment through checklist API
  it('6. Technician cannot modify assignment or metadata through checklist API', async () => {
    // Attempting to send title / assignment payload as technician
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${createdItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({
        title: 'Tampered Title',
        technicianId: unassignedTechId,
      }),
    });

    // Since technician didn't provide result/notes, server rejects with 400 No valid fields provided
    assert.equal(res.status, 400);

    // Verify title was not changed in DB
    const item = await prisma.inspectionChecklistItem.findUnique({ where: { id: createdItemId } });
    assert.equal(item?.title, 'Brake Pad Thickness');

    // Verify technician assignment unchanged
    const assignments = await prisma.technicianAssignment.findMany({ where: { serviceRecordId: service1Id } });
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].userId, assignedTechId);
  });

  // Test 7: Technician cannot access checklist of another service by ID
  it('7. Technician cannot access checklist of another unassigned service by ID', async () => {
    // service2 has no assignment for assignedTech
    const res = await fetch(`${baseUrl}/api/services/${service2Id}/checklist`, {
      headers: { Authorization: `Bearer ${assignedTechToken}` },
    });
    assert.equal(res.status, 403);

    // Cross-service IDOR: targeting service2 with createdItemId that belongs to service1
    const idorRes = await fetch(`${baseUrl}/api/services/${service2Id}/checklist/${createdItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`, // Even manager targeting mismatched service gets 404
      },
      body: JSON.stringify({ result: 'FAIL' }),
    });
    assert.equal(idorRes.status, 404);
  });

  // Test 8: Manager can view checklist
  it('8. Manager can view checklist for any service', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].id, createdItemId);
  });

  // Test 9: Invalid result rejected
  it('9. Invalid result rejected with 400', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${createdItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({
        result: 'SUPER_PASS',
      }),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /Invalid result/i);
  });

  // Test 10: Empty/invalid title rejected
  it('10. Empty or invalid title rejected on creation', async () => {
    // Empty title
    const res1 = await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ title: '   ' }),
    });
    assert.equal(res1.status, 400);

    // Missing title
    const res2 = await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ description: 'No title provided' }),
    });
    assert.equal(res2.status, 400);
  });

  // Test 11: Completed service checklist mutation follows the chosen rule (blocked)
  it('11. Completed service checklist mutation is blocked (read-only)', async () => {
    // Try to add item to completed service
    const postRes = await fetch(`${baseUrl}/api/services/${completedServiceId}/checklist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ title: 'Post-completion item' }),
    });
    assert.equal(postRes.status, 400);
    const postErr = await postRes.json();
    assert.match(postErr.error, /completed service/i);

    // Pre-create an item directly in DB on completed service to test PUT/DELETE
    const directItem = await prisma.inspectionChecklistItem.create({
      data: {
        serviceRecordId: completedServiceId,
        title: 'Historic item',
        result: 'PASS',
      },
    });

    // Try to mutate via PUT
    const putRes = await fetch(`${baseUrl}/api/services/${completedServiceId}/checklist/${directItem.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({ result: 'FAIL' }),
    });
    assert.equal(putRes.status, 400);
    const putErr = await putRes.json();
    assert.match(putErr.error, /completed service/i);

    // Try to delete via DELETE
    const delRes = await fetch(`${baseUrl}/api/services/${completedServiceId}/checklist/${directItem.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    assert.equal(delRes.status, 400);
    const delErr = await delRes.json();
    assert.match(delErr.error, /completed service/i);

    // But reading is allowed!
    const getRes = await fetch(`${baseUrl}/api/services/${completedServiceId}/checklist`, {
      headers: { Authorization: `Bearer ${assignedTechToken}` },
    });
    assert.equal(getRes.status, 200);
    const list = await getRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Historic item');
  });

  // Test 12: Audit event is created for material checklist changes
  it('12. Audit event is created for CHECKLIST_ITEM_CREATED, CHECKLIST_RESULT_UPDATED, and CHECKLIST_ITEM_DELETED', async () => {
    // 12a. Create a new item to test full audit trail
    const createRes = await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({ title: 'Engine Oil Level', required: false }),
    });
    assert.equal(createRes.status, 201);
    const itemData = await createRes.json();

    const createAudit = await prisma.auditLog.findFirst({
      where: {
        serviceRecordId: service1Id,
        action: 'CHECKLIST_ITEM_CREATED',
        newValue: 'Engine Oil Level',
      },
    });
    assert.ok(createAudit, 'CHECKLIST_ITEM_CREATED audit log must exist');
    assert.equal(createAudit.changedById, managerId);

    // 12b. Update result
    const updateRes = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${itemData.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assignedTechToken}`,
      },
      body: JSON.stringify({ result: 'FAIL', notes: 'Oil level below MIN marker' }),
    });
    assert.equal(updateRes.status, 200);

    const updateAudit = await prisma.auditLog.findFirst({
      where: {
        serviceRecordId: service1Id,
        action: 'CHECKLIST_RESULT_UPDATED',
        oldValue: 'PENDING',
        newValue: 'FAIL',
      },
    });
    assert.ok(updateAudit, 'CHECKLIST_RESULT_UPDATED audit log must exist');
    assert.equal(updateAudit.changedById, assignedTechId);

    // 12c. Delete item
    const deleteRes = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${itemData.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    assert.equal(deleteRes.status, 200);

    const deleteAudit = await prisma.auditLog.findFirst({
      where: {
        serviceRecordId: service1Id,
        action: 'CHECKLIST_ITEM_DELETED',
        oldValue: 'Engine Oil Level',
      },
    });
    assert.ok(deleteAudit, 'CHECKLIST_ITEM_DELETED audit log must exist');
    assert.equal(deleteAudit.changedById, managerId);
    assert.equal(deleteAudit.serviceRecordId, service1Id);
    assert.equal(deleteAudit.vehicleId, vehicleId);

    // Deleting item must NOT have deleted the audit log!
    const itemInDb = await prisma.inspectionChecklistItem.findUnique({ where: { id: itemData.id } });
    assert.equal(itemInDb, null);
    const auditStillInDb = await prisma.auditLog.findUnique({ where: { id: deleteAudit.id } });
    assert.ok(auditStillInDb, 'Audit log remains immutable after item deletion');
  });

  // Test 13: GET checklist does not create audit events
  it('13. GET checklist does not create audit events', async () => {
    const auditCountBefore = await prisma.auditLog.count({
      where: { serviceRecordId: service1Id },
    });

    // Perform multiple GET requests
    await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    await fetch(`${baseUrl}/api/services/${service1Id}/checklist`, {
      headers: { Authorization: `Bearer ${assignedTechToken}` },
    });

    const auditCountAfter = await prisma.auditLog.count({
      where: { serviceRecordId: service1Id },
    });

    assert.equal(auditCountAfter, auditCountBefore, 'Audit count must not increase on GET requests');
  });

  // Test 14: Administrative override by Fleet Manager
  it('14. Fleet Manager can override checklist result and edit title/description', async () => {
    const res = await fetch(`${baseUrl}/api/services/${service1Id}/checklist/${createdItemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
      },
      body: JSON.stringify({
        title: 'Brake Pad & Rotor Thickness',
        result: 'NOT_APPLICABLE',
        notes: 'Fleet manager override: rotors replaced last week',
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.title, 'Brake Pad & Rotor Thickness');
    assert.equal(data.result, 'NOT_APPLICABLE');
    assert.equal(data.notes, 'Fleet manager override: rotors replaced last week');
    assert.equal(data.checkedById, managerId);
  });
});
