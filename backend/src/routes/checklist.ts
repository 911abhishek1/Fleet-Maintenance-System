import { Router, Response } from 'express';
import { requireAuth, requireFleetManager, AuthRequest } from '../middleware/auth';
import prisma from '../db';
import { logAuditEvent } from '../domain/audit';
import { ChecklistItemResult } from '@prisma/client';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const VALID_RESULTS: ChecklistItemResult[] = ['PENDING', 'PASS', 'FAIL', 'NOT_APPLICABLE'];

/**
 * GET /api/services/:serviceId/checklist
 * View checklist items for a service.
 * - Fleet Manager: allowed for any service.
 * - Technician: allowed ONLY if assigned to the service. Unassigned -> 403.
 * - Idempotent: NEVER creates audit logs.
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const serviceId = Array.isArray(req.params.serviceId) ? req.params.serviceId[0] : req.params.serviceId;
  const user = req.user!;

  try {
    const serviceRecord = await prisma.serviceRecord.findUnique({
      where: { id: serviceId },
      include: {
        assignments: { select: { userId: true } },
      },
    });

    if (!serviceRecord) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    if (user.role === 'TECHNICIAN') {
      const isAssigned = serviceRecord.assignments.some((a) => a.userId === user.id);
      if (!isAssigned) {
        res.status(403).json({ error: 'Forbidden: You are not assigned to this service record' });
        return;
      }
    }

    const items = await prisma.inspectionChecklistItem.findMany({
      where: { serviceRecordId: serviceId },
      orderBy: { createdAt: 'asc' },
      include: {
        checkedBy: { select: { id: true, email: true, role: true } },
      },
    });

    res.json(items);
  } catch (error) {
    console.error('Get checklist error:', error);
    res.status(500).json({ error: 'Failed to get checklist items' });
  }
});

/**
 * POST /api/services/:serviceId/checklist
 * Add a checklist item to a service.
 * - Fleet Manager ONLY. (Technician -> 403)
 * - Service must NOT be COMPLETED.
 * - Validates non-empty title.
 * - Transactionally creates item and CHECKLIST_ITEM_CREATED audit record.
 */
router.post('/', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const serviceId = Array.isArray(req.params.serviceId) ? req.params.serviceId[0] : req.params.serviceId;
  const { title, description, required } = req.body;
  const user = req.user!;

  if (!title || typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'Checklist item title is required and cannot be empty' });
    return;
  }

  if (title.trim().length > 200) {
    res.status(400).json({ error: 'Checklist item title must not exceed 200 characters' });
    return;
  }

  if (description && (typeof description !== 'string' || description.trim().length > 500)) {
    res.status(400).json({ error: 'Description must not exceed 500 characters' });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const serviceRecord = await tx.serviceRecord.findUnique({
        where: { id: serviceId },
      });

      if (!serviceRecord) {
        return { error: 'Service record not found', status: 404 };
      }

      if (serviceRecord.status === 'COMPLETED') {
        return { error: 'Cannot add checklist items to a completed service', status: 400 };
      }

      const created = await tx.inspectionChecklistItem.create({
        data: {
          serviceRecordId: serviceId,
          title: title.trim(),
          description: description ? description.trim() : null,
          required: Boolean(required),
          result: 'PENDING',
        },
        include: {
          checkedBy: { select: { id: true, email: true, role: true } },
        },
      });

      await logAuditEvent(tx, {
        serviceRecordId: serviceId,
        vehicleId: serviceRecord.vehicleId,
        changedById: user.id,
        action: 'CHECKLIST_ITEM_CREATED',
        field: 'title',
        oldValue: null,
        newValue: created.title,
        notes: created.required ? 'Required inspection item' : null,
      });

      return { item: created, status: 201 };
    });

    if (result.error) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(201).json(result.item);
  } catch (error) {
    console.error('Create checklist item error:', error);
    res.status(500).json({ error: 'Failed to create checklist item' });
  }
});

/**
 * PUT /api/services/:serviceId/checklist/:itemId
 * Update checklist item result and/or notes.
 * - Fleet Manager: administrative override allowed.
 * - Assigned Technician: allowed for assigned service.
 * - Unassigned Technician: 403 Forbidden.
 * - Service must NOT be COMPLETED.
 * - Validates item belongs to serviceId (prevent IDOR).
 * - Transactionally updates item and logs CHECKLIST_RESULT_UPDATED.
 */
router.put('/:itemId', async (req: AuthRequest, res: Response): Promise<void> => {
  const serviceId = Array.isArray(req.params.serviceId) ? req.params.serviceId[0] : req.params.serviceId;
  const itemId = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
  const { result, notes, title, description, required } = req.body;
  const user = req.user!;

  if (result !== undefined && !VALID_RESULTS.includes(result)) {
    res.status(400).json({
      error: `Invalid result. Allowed values: ${VALID_RESULTS.join(', ')}`,
    });
    return;
  }

  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    res.status(400).json({ error: 'Notes must be a string' });
    return;
  }

  if (typeof notes === 'string' && notes.length > 1000) {
    res.status(400).json({ error: 'Notes must not exceed 1000 characters' });
    return;
  }

  try {
    const transactionResult = await prisma.$transaction(async (tx) => {
      // 1. Verify service record exists
      const serviceRecord = await tx.serviceRecord.findUnique({
        where: { id: serviceId },
        include: {
          assignments: { select: { userId: true } },
        },
      });

      if (!serviceRecord) {
        return { error: 'Service record not found', status: 404 };
      }

      // 2. Immutability check on completed services
      if (serviceRecord.status === 'COMPLETED') {
        return { error: 'Cannot modify checklist items of a completed service', status: 400 };
      }

      // 3. Authorization check
      if (user.role === 'TECHNICIAN') {
        const isAssigned = serviceRecord.assignments.some((a) => a.userId === user.id);
        if (!isAssigned) {
          return { error: 'Forbidden: You are not assigned to this service record', status: 403 };
        }
      }

      // 4. Verify item exists and belongs to this service (IDOR check)
      const existingItem = await tx.inspectionChecklistItem.findUnique({
        where: { id: itemId },
      });

      if (!existingItem || existingItem.serviceRecordId !== serviceId) {
        return { error: 'Checklist item not found for this service', status: 404 };
      }

      // 5. Construct update payload
      const updateData: any = {};

      if (result !== undefined) {
        updateData.result = result;
        updateData.checkedById = result === 'PENDING' ? null : user.id;
      }

      if (notes !== undefined) {
        updateData.notes = notes ? notes.trim() : null;
      }

      // Fleet managers can additionally edit metadata
      if (user.role === 'FLEET_MANAGER') {
        if (title !== undefined) {
          if (typeof title !== 'string' || !title.trim()) {
            return { error: 'Title cannot be empty', status: 400 };
          }
          updateData.title = title.trim();
        }
        if (description !== undefined) {
          updateData.description = description ? description.trim() : null;
        }
        if (required !== undefined) {
          updateData.required = Boolean(required);
        }
      }

      if (Object.keys(updateData).length === 0) {
        return { error: 'No valid fields provided for update', status: 400 };
      }

      const updated = await tx.inspectionChecklistItem.update({
        where: { id: itemId },
        data: updateData,
        include: {
          checkedBy: { select: { id: true, email: true, role: true } },
        },
      });

      // 6. Audit logging
      const resultChanged = result !== undefined && result !== existingItem.result;
      const notesChanged = notes !== undefined && (notes ? notes.trim() : null) !== existingItem.notes;

      if (resultChanged) {
        await logAuditEvent(tx, {
          serviceRecordId: serviceId,
          vehicleId: serviceRecord.vehicleId,
          changedById: user.id,
          action: 'CHECKLIST_RESULT_UPDATED',
          field: 'result',
          oldValue: existingItem.result,
          newValue: updated.result,
          notes: `${existingItem.title}${updated.notes ? ': ' + updated.notes : ''}`,
        });
      } else if (notesChanged) {
        await logAuditEvent(tx, {
          serviceRecordId: serviceId,
          vehicleId: serviceRecord.vehicleId,
          changedById: user.id,
          action: 'CHECKLIST_RESULT_UPDATED',
          field: 'notes',
          oldValue: existingItem.notes,
          newValue: updated.notes,
          notes: existingItem.title,
        });
      }

      return { item: updated, status: 200 };
    });

    if (transactionResult.error) {
      res.status(transactionResult.status).json({ error: transactionResult.error });
      return;
    }

    res.json(transactionResult.item);
  } catch (error) {
    console.error('Update checklist item error:', error);
    res.status(500).json({ error: 'Failed to update checklist item' });
  }
});

/**
 * DELETE /api/services/:serviceId/checklist/:itemId
 * Delete a checklist item from a service.
 * - Fleet Manager ONLY. (Technician -> 403)
 * - Service must NOT be COMPLETED.
 * - Validates item belongs to serviceId.
 * - Audit log CHECKLIST_ITEM_DELETED created BEFORE deletion.
 */
router.delete('/:itemId', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const serviceId = Array.isArray(req.params.serviceId) ? req.params.serviceId[0] : req.params.serviceId;
  const itemId = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
  const user = req.user!;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const serviceRecord = await tx.serviceRecord.findUnique({
        where: { id: serviceId },
      });

      if (!serviceRecord) {
        return { error: 'Service record not found', status: 404 };
      }

      if (serviceRecord.status === 'COMPLETED') {
        return { error: 'Cannot delete checklist items of a completed service', status: 400 };
      }

      const existingItem = await tx.inspectionChecklistItem.findUnique({
        where: { id: itemId },
      });

      if (!existingItem || existingItem.serviceRecordId !== serviceId) {
        return { error: 'Checklist item not found for this service', status: 404 };
      }

      // Log audit event before deletion to capture item details
      await logAuditEvent(tx, {
        serviceRecordId: serviceId,
        vehicleId: serviceRecord.vehicleId,
        changedById: user.id,
        action: 'CHECKLIST_ITEM_DELETED',
        field: 'title',
        oldValue: existingItem.title,
        newValue: null,
        notes: `Deleted item (result was ${existingItem.result})`,
      });

      await tx.inspectionChecklistItem.delete({
        where: { id: itemId },
      });

      return { status: 200 };
    });

    if (result.error) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({ message: 'Checklist item deleted' });
  } catch (error) {
    console.error('Delete checklist item error:', error);
    res.status(500).json({ error: 'Failed to delete checklist item' });
  }
});

export default router;
