import { Router, Response } from 'express';
import { requireAuth, requireFleetManager, requireTechnician, AuthRequest } from '../middleware/auth';
import prisma from '../db';

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
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '10', description, vehicleId, status, technicianId, sortBy = 'dateScheduled', sortOrder = 'asc' } = req.query;
    
    const pageNumber = parseInt(page as string);
    const limitNumber = parseInt(limit as string);
    const skip = (pageNumber - 1) * limitNumber;

    const where: any = {};
    if (description) where.description = { contains: description as string, mode: 'insensitive' };
    if (vehicleId) where.vehicleId = vehicleId;
    if (status) where.status = status;
    if (technicianId) {
      where.assignments = {
        some: { userId: technicianId }
      };
    }

    const orderBy = {
      [sortBy as string]: sortOrder
    };

    const [records, total] = await Promise.all([
      prisma.serviceRecord.findMany({
        where,
        skip,
        take: limitNumber,
        orderBy,
        include: { vehicle: true, assignments: { include: { user: true } } }
      }),
      prisma.serviceRecord.count({ where })
    ]);

    res.json({ records, total, page: pageNumber, limit: limitNumber });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/services/export-csv - CSV export of service history
router.get('/export-csv', requireFleetManager, async (req: AuthRequest, res: Response) => {
  try {
    const records = await prisma.serviceRecord.findMany({
      include: { vehicle: true, assignments: { include: { user: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const headers = ['ID', 'Vehicle Registration', 'Description', 'Status', 'Date Scheduled', 'Date Completed', 'Completed Odometer', 'Technicians'];
    const rows = records.map(r => [
      r.id,
      r.vehicle.registration,
      `"${r.description.replace(/"/g, '""')}"`,
      r.status,
      r.dateScheduled?.toISOString() || '',
      r.dateCompleted?.toISOString() || '',
      r.completedOdometer || '',
      `"${r.assignments.map(a => a.user.email).join(', ')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="service-history.csv"');
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// POST /api/services - Create service record (Fleet Manager only)
router.post('/', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const { vehicleId, description, status } = req.body;

  try {
    const record = await prisma.serviceRecord.create({
      data: {
        vehicleId,
        description,
        status: status || 'DUE'
      }
    });
    res.status(201).json(record);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create service record' });
  }
});

// PUT /api/services/:id - Update service record
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const { description, status, dateScheduled, completedOdometer } = req.body;
  const userRole = req.user?.role;
  const userId = req.user?.id;

  try {
    const existingRecord = await prisma.serviceRecord.findUnique({
      where: { id },
      include: { assignments: true, vehicle: true }
    });

    if (!existingRecord) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    if (userRole === 'TECHNICIAN') {
      const isAssigned = existingRecord.assignments.some(a => a.userId === userId);
      if (!isAssigned) {
        res.status(403).json({ error: 'Forbidden: You are not assigned to this service record' });
        return;
      }
      
      const updatedRecord = await prisma.serviceRecord.update({
        where: { id },
        data: { description }
      });
      res.json(updatedRecord);
      return;
    }

    // --- Fleet Manager Logic ---

    // State Machine Validation
    if (status && status !== existingRecord.status) {
      const validTransitions: Record<string, string[]> = {
        'DUE': ['BOOKED', 'OVERDUE'],
        'OVERDUE': ['BOOKED'],
        'BOOKED': ['IN_SERVICE'],
        'IN_SERVICE': ['COMPLETED']
      };
      
      const allowed = validTransitions[existingRecord.status] || [];
      if (!allowed.includes(status)) {
        res.status(400).json({ error: `Invalid transition from ${existingRecord.status} to ${status}` });
        return;
      }
    }

    const updateData: any = { description };
    if (status) updateData.status = status;
    if (dateScheduled) updateData.dateScheduled = new Date(dateScheduled);

    if (status === 'COMPLETED' && existingRecord.status !== 'COMPLETED') {
      if (!completedOdometer) {
        res.status(400).json({ error: 'completedOdometer is required when completing a service' });
        return;
      }
      updateData.completedOdometer = parseInt(completedOdometer);
      updateData.dateCompleted = new Date();

      // Reset counters on vehicle
      await prisma.vehicle.update({
        where: { id: existingRecord.vehicleId },
        data: {
          odometer: parseInt(completedOdometer)
          // The "reset" of intervals means the next DUE date/mileage is calculated from THIS completed date/odometer.
          // Since our schema only stores the intervals and current odometer, we might need a background job or calculation to determine next due.
          // By updating odometer here, we effectively reset the mileage counter.
        }
      });
    }

    const updatedRecord = await prisma.serviceRecord.update({
      where: { id },
      data: updateData
    });
    res.json(updatedRecord);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update service record' });
  }
});

// POST /api/services/:id/assignments - Add technician (Fleet Manager)
router.post('/:id/assignments', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const input = ((req.body.technicianId || req.body.email || '') as string).trim();

  if (!input) {
    res.status(400).json({ error: 'Technician email or ID is required' });
    return;
  }

  try {
    // 1. Verify service record exists
    const serviceRecord = await prisma.serviceRecord.findUnique({
      where: { id },
    });
    if (!serviceRecord) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    // 2. Resolve target user (by email or ID)
    const targetUser = input.includes('@')
      ? await prisma.user.findUnique({ where: { email: input } })
      : await prisma.user.findUnique({ where: { id: input } });

    if (!targetUser) {
      res.status(404).json({
        error: input.includes('@')
          ? `No technician found with email "${input}". Make sure they have registered.`
          : `No technician found with ID "${input}".`,
      });
      return;
    }

    // 3. Verify user has role TECHNICIAN (reject Fleet Managers)
    if (targetUser.role !== 'TECHNICIAN') {
      res.status(400).json({
        error: `Cannot assign user with role "${targetUser.role}". Only users with role "TECHNICIAN" can be assigned to services.`,
      });
      return;
    }

    // 4. Check if technician is already assigned
    const existing = await prisma.technicianAssignment.findUnique({
      where: {
        serviceRecordId_userId: {
          serviceRecordId: id,
          userId: targetUser.id,
        },
      },
    });

    if (existing) {
      res.status(400).json({ error: 'This technician is already assigned to this service' });
      return;
    }

    // 5. Create assignment
    const assignment = await prisma.technicianAssignment.create({
      data: {
        serviceRecordId: id,
        userId: targetUser.id,
      },
      include: {
        user: { select: { id: true, email: true, role: true } },
      },
    });
    res.status(201).json(assignment);
  } catch (error) {
    console.error('Assign technician error:', error);
    res.status(500).json({ error: 'Failed to assign technician' });
  }
});

// DELETE /api/services/:id/assignments/:technicianId - Remove technician
router.delete('/:id/assignments/:technicianId', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id, technicianId } = req.params;
  try {
    await prisma.technicianAssignment.delete({
      where: {
        serviceRecordId_userId: {
          serviceRecordId: id,
          userId: technicianId
        }
      }
    });
    res.json({ message: 'Assignment removed' });
  } catch (error) {
    res.status(400).json({ error: 'Failed to remove assignment' });
  }
});

export default router;
