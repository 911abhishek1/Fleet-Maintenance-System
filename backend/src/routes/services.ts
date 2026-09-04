import { Router, Response } from 'express';
import { stringify } from 'csv-stringify/sync';
import { requireAuth, requireFleetManager, requireTechnician, AuthRequest } from '../middleware/auth';
import prisma from '../db';
import { updateServiceRecord } from '../services/serviceLifecycle';
import { ValidationError, InvalidTransitionError, ForbiddenActionError } from '../domain/lifecycle';
import { logAuditEvent } from '../domain/audit';

const router = Router();
router.use(requireAuth);

// GET /api/services - Get all services (Fleet Manager) or assigned services (Technician)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.id;

    if (userRole === 'FLEET_MANAGER') {
      const records = await prisma.serviceRecord.findMany({
        include: { vehicle: true, assignments: { include: { user: true } } }
      });
      res.json(records);
    } else {
      // TECHNICIAN
      const records = await prisma.serviceRecord.findMany({
        where: {
          assignments: {
            some: {
              userId: userId
            }
          }
        },
        include: { vehicle: true, assignments: { include: { user: true } } }
      });
      res.json(records);
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/services/search - Advanced search and pagination
router.get('/search', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.id;

    const {
      page = '1',
      limit = '10',
      description,
      vehicleId,
      status,
      technicianId,
      sortBy = 'dateScheduled',
      sortOrder = 'asc',
    } = req.query;

    // 1. Pagination validation
    const pageNumber = Number(page);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      res.status(400).json({ error: 'Invalid page number. Must be an integer >= 1' });
      return;
    }

    const limitNumber = Number(limit);
    if (!Number.isInteger(limitNumber) || limitNumber < 1 || limitNumber > 100) {
      res.status(400).json({ error: 'Invalid limit. Must be an integer between 1 and 100' });
      return;
    }

    // 2. Sorting validation
    const allowedSortFields = ['dateScheduled', 'status', 'updatedAt'];
    const sortFieldStr = String(sortBy);
    if (!allowedSortFields.includes(sortFieldStr)) {
      res.status(400).json({
        error: `Invalid sort field "${sortFieldStr}". Allowed fields: ${allowedSortFields.join(', ')}`,
      });
      return;
    }

    const sortOrderLower = String(sortOrder).toLowerCase();
    if (!['asc', 'desc'].includes(sortOrderLower)) {
      res.status(400).json({ error: 'Invalid sort order. Allowed: asc, desc' });
      return;
    }

    // 3. Status validation (if provided)
    if (status && !['DUE', 'BOOKED', 'IN_SERVICE', 'COMPLETED'].includes(String(status))) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    // 4. Build filter criteria
    const where: any = {};

    if (description && String(description).trim()) {
      where.description = { contains: String(description).trim(), mode: 'insensitive' };
    }

    if (vehicleId && String(vehicleId).trim()) {
      where.vehicleId = String(vehicleId).trim();
    }

    if (status) {
      where.status = String(status);
    }

    // Role-based technician scoping:
    // Technicians are strictly locked to their own assigned records, ignoring any query parameter.
    if (userRole === 'TECHNICIAN') {
      where.assignments = {
        some: { userId },
      };
    } else if (technicianId && String(technicianId).trim()) {
      where.assignments = {
        some: { userId: String(technicianId).trim() },
      };
    }

    const skip = (pageNumber - 1) * limitNumber;
    const orderBy = {
      [sortFieldStr]: sortOrderLower as 'asc' | 'desc',
    };

    const [records, total] = await Promise.all([
      prisma.serviceRecord.findMany({
        where,
        skip,
        take: limitNumber,
        orderBy,
        include: {
          vehicle: true,
          assignments: {
            include: {
              user: { select: { id: true, email: true, role: true } },
            },
          },
        },
      }),
      prisma.serviceRecord.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limitNumber);

    res.json({
      records,
      page: pageNumber,
      limit: limitNumber,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Service search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/services/export-csv - CSV export of service history (Fleet Manager only)
router.get('/export-csv', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const records = await prisma.serviceRecord.findMany({
      include: {
        vehicle: true,
        assignments: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = records.map((r) => [
      r.id,
      r.vehicle?.registration || '',
      r.description,
      r.status,
      r.dateScheduled ? r.dateScheduled.toISOString() : '',
      r.dateCompleted ? r.dateCompleted.toISOString() : '',
      r.completedOdometer !== null && r.completedOdometer !== undefined ? String(r.completedOdometer) : '',
      r.assignments.map((a) => a.user.email).join(', '),
    ]);

    const csvOutput = stringify([
      ['Service ID', 'Vehicle Registration', 'Description', 'Status', 'Date Scheduled', 'Date Completed', 'Completed Odometer', 'Technicians'],
      ...rows,
    ]);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="service-history.csv"');
    res.send(csvOutput);
  } catch (error) {
    console.error('Failed to export CSV:', error);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// GET /api/services/:id - Get service record by ID (Fleet Manager or Assigned Technician)
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const userRole = req.user?.role;
  const userId = req.user?.id;

  try {
    const serviceRecord = await prisma.serviceRecord.findUnique({
      where: { id },
      include: {
        vehicle: true,
        assignments: {
          include: {
            user: { select: { id: true, email: true, role: true } },
          },
        },
      },
    });

    if (!serviceRecord) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    if (userRole === 'TECHNICIAN') {
      const isAssigned = serviceRecord.assignments.some((a) => a.userId === userId);
      if (!isAssigned) {
        res.status(403).json({ error: 'Forbidden: You are not assigned to this service record' });
        return;
      }
    }

    res.json(serviceRecord);
  } catch (error) {
    console.error('Get service record error:', error);
    res.status(500).json({ error: 'Failed to get service record' });
  }
});

// POST /api/services - Create service record (Fleet Manager only)
// Always initializes status to DUE and sets dueDate to creation time (due now).
router.post('/', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const { vehicleId, description } = req.body;

  try {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });

    if (!vehicle) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const creationTime = new Date();

    // Atomically create service record and SERVICE_CREATED audit log
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.serviceRecord.create({
        data: {
          vehicleId,
          description: description || 'Routine maintenance',
          status: 'DUE', // Always DUE; client cannot override initial status
          cycle: vehicle.serviceCycle,
          dueDate: creationTime, // Manually created DUE service represents work that is due now
        },
        include: {
          vehicle: true,
          assignments: { include: { user: { select: { id: true, email: true, role: true } } } },
        },
      });

      await logAuditEvent(tx, {
        serviceRecordId: created.id,
        vehicleId: vehicle.id,
        changedById: req.user?.id,
        action: 'SERVICE_CREATED',
        field: 'status',
        oldValue: null,
        newValue: 'DUE',
        notes: created.description,
      });

      return created;
    });

    res.status(201).json(record);
  } catch (error) {
    console.error('Create service error:', error);
    res.status(400).json({ error: 'Failed to create service record' });
  }
});

// PUT /api/services/:id - Update service record / transition lifecycle
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { description, status, dateScheduled, completedOdometer } = req.body;
  const caller = req.user;

  if (!caller) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Parse completedOdometer if provided as a numeric string (HTTP transport compatibility)
  const parsedCompletedOdometer =
    completedOdometer !== undefined && completedOdometer !== null && completedOdometer !== ''
      ? (typeof completedOdometer === 'string' && !isNaN(Number(completedOdometer))
          ? Number(completedOdometer)
          : completedOdometer)
      : completedOdometer;

  try {
    const result = await updateServiceRecord(
      id,
      { id: caller.id, role: caller.role as 'FLEET_MANAGER' | 'TECHNICIAN' },
      { description, status, dateScheduled, completedOdometer: parsedCompletedOdometer }
    );
    res.json(result.service);
  } catch (error: any) {
    if (error instanceof ValidationError || error instanceof InvalidTransitionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof ForbiddenActionError) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error('Update service record error:', error);
    res.status(500).json({ error: 'Failed to update service record' });
  }
});

// POST /api/services/:id/assignments - Add technician (Fleet Manager only, atomic with audit log)
router.post('/:id/assignments', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const input = ((req.body.technicianId || req.body.email || '') as string).trim();

  if (!input) {
    res.status(400).json({ error: 'Technician email or ID is required' });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Verify service record exists
      const serviceRecord = await tx.serviceRecord.findUnique({
        where: { id },
      });
      if (!serviceRecord) {
        return { error: 'Service record not found', status: 404 };
      }

      // 2. Resolve target user (by email or ID)
      const targetUser = input.includes('@')
        ? await tx.user.findUnique({ where: { email: input } })
        : await tx.user.findUnique({ where: { id: input } });

      if (!targetUser) {
        return {
          error: input.includes('@')
            ? `No technician found with email "${input}". Make sure they have registered.`
            : `No technician found with ID "${input}".`,
          status: 404,
        };
      }

      // 3. Verify user has role TECHNICIAN (reject Fleet Managers)
      if (targetUser.role !== 'TECHNICIAN') {
        return {
          error: `Cannot assign user with role "${targetUser.role}". Only users with role "TECHNICIAN" can be assigned to services.`,
          status: 400,
        };
      }

      // 4. Check if technician is already assigned
      const existing = await tx.technicianAssignment.findUnique({
        where: {
          serviceRecordId_userId: {
            serviceRecordId: id,
            userId: targetUser.id,
          },
        },
      });

      if (existing) {
        return { error: 'This technician is already assigned to this service', status: 400 };
      }

      // 5. Create assignment
      const assignment = await tx.technicianAssignment.create({
        data: {
          serviceRecordId: id,
          userId: targetUser.id,
        },
        include: {
          user: { select: { id: true, email: true, role: true } },
        },
      });

      // 6. Create audit event atomically
      await logAuditEvent(tx, {
        action: 'TECHNICIAN_ASSIGNED',
        serviceRecordId: id,
        vehicleId: serviceRecord.vehicleId,
        changedById: req.user?.id,
        field: 'technicianId',
        oldValue: null,
        newValue: targetUser.id,
        notes: `Assigned technician ${targetUser.email} (${targetUser.id})`,
      });

      return { assignment, status: 201 };
    });

    if (result.error) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(201).json(result.assignment);
  } catch (error) {
    console.error('Assign technician error:', error);
    res.status(500).json({ error: 'Failed to assign technician' });
  }
});

// DELETE /api/services/:id/assignments/:technicianId - Remove technician (Fleet Manager only, atomic with audit log)
router.delete('/:id/assignments/:technicianId', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const technicianId = Array.isArray(req.params.technicianId) ? req.params.technicianId[0] : req.params.technicianId;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Verify service record exists
      const serviceRecord = await tx.serviceRecord.findUnique({
        where: { id },
      });
      if (!serviceRecord) {
        return { error: 'Service record not found', status: 404 };
      }

      // 2. Check assignment exists
      const existing = await tx.technicianAssignment.findUnique({
        where: {
          serviceRecordId_userId: {
            serviceRecordId: id,
            userId: technicianId,
          },
        },
        include: {
          user: { select: { id: true, email: true, role: true } },
        },
      });

      if (!existing) {
        return { error: 'Technician assignment not found', status: 404 };
      }

      // 3. Delete assignment
      await tx.technicianAssignment.delete({
        where: {
          serviceRecordId_userId: {
            serviceRecordId: id,
            userId: technicianId,
          },
        },
      });

      // 4. Create audit event atomically
      await logAuditEvent(tx, {
        action: 'TECHNICIAN_UNASSIGNED',
        serviceRecordId: id,
        vehicleId: serviceRecord.vehicleId,
        changedById: req.user?.id,
        field: 'technicianId',
        oldValue: technicianId,
        newValue: null,
        notes: `Removed technician ${existing.user.email} (${existing.user.id})`,
      });

      return { status: 200 };
    });

    if (result.error) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({ message: 'Assignment removed' });
  } catch (error) {
    console.error('Remove assignment error:', error);
    res.status(400).json({ error: 'Failed to remove assignment' });
  }
});

export default router;
