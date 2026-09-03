import { Router, Response } from 'express';
import { requireAuth, requireFleetManager, AuthRequest } from '../middleware/auth';
import prisma from '../db';
import { evaluateServiceDue } from '../domain/maintenance';
import { logAuditEvent } from '../domain/audit';

const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

// GET /api/vehicles - List all vehicles with server-side search, filtering, sorting, and pagination (Fleet Manager only)
router.get('/', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      page = '1',
      limit = '10',
      search,
      archived,
      sortBy = 'createdAt',
      sortOrder = 'desc',
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
    const allowedSortFields = ['registration', 'make', 'model', 'odometer', 'createdAt', 'updatedAt'];
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

    // 3. Build filter criteria
    const where: any = {};

    // Search matches registration, make, or model
    if (search && String(search).trim()) {
      const q = String(search).trim();
      where.OR = [
        { registration: { contains: q, mode: 'insensitive' } },
        { make: { contains: q, mode: 'insensitive' } },
        { model: { contains: q, mode: 'insensitive' } },
      ];
    }

    // Archived filter:
    // Default excludes archived vehicles.
    // 'true' returns archived vehicles.
    // 'all' includes both active and archived.
    if (archived === 'true') {
      where.archived = true;
    } else if (archived === 'all') {
      // no archived restriction
    } else {
      where.archived = false;
    }

    const skip = (pageNumber - 1) * limitNumber;
    const orderBy = {
      [sortFieldStr]: sortOrderLower as 'asc' | 'desc',
    };

    const [vehicles, total] = await Promise.all([
      prisma.vehicle.findMany({
        where,
        skip,
        take: limitNumber,
        orderBy,
        include: {
          serviceRecords: true,
        },
      }),
      prisma.vehicle.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limitNumber);

    res.json({
      vehicles,
      records: vehicles,
      page: pageNumber,
      limit: limitNumber,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Vehicle listing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/vehicles/evaluate-status - Auto-flag DUE maintenance based on pure domain rules
router.post('/evaluate-status', requireFleetManager, async (req: AuthRequest, res: Response) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      include: {
        serviceRecords: true,
      },
    });

    const now = new Date();
    let flaggedDue = 0;

    for (const vehicle of vehicles) {
      // Check if there is already an active service record for the vehicle
      const hasActiveService = vehicle.serviceRecords.some((r) => r.status !== 'COMPLETED');
      if (hasActiveService) {
        continue;
      }

      // Evaluate whether vehicle is due using pure domain calculation
      const dueEval = evaluateServiceDue(
        {
          odometer: vehicle.odometer,
          lastServiceDate: vehicle.lastServiceDate,
          lastServiceMileage: vehicle.lastServiceMileage,
          dateIntervalDays: vehicle.dateIntervalDays,
          mileageInterval: vehicle.mileageInterval,
        },
        now
      );

      if (dueEval.isDue) {
        const newRecord = await prisma.serviceRecord.create({
          data: {
            vehicleId: vehicle.id,
            description: `Scheduled maintenance (due by ${dueEval.trigger})`,
            status: 'DUE',
            cycle: vehicle.serviceCycle,
            dueDate: dueEval.canonicalDueDate,
          },
        });

        await logAuditEvent(prisma, {
          serviceRecordId: newRecord.id,
          vehicleId: vehicle.id,
          changedById: req.user?.id,
          action: 'SERVICE_CREATED',
          field: 'status',
          oldValue: null,
          newValue: 'DUE',
          notes: `Auto-evaluated due maintenance by ${dueEval.trigger}. Canonical dueDate: ${dueEval.canonicalDueDate?.toISOString()}`,
        });

        flaggedDue++;
      }
    }

    res.json({ message: 'Evaluation complete', flaggedDue });
  } catch (error) {
    console.error('Failed to evaluate status:', error);
    res.status(500).json({ error: 'Failed to evaluate status' });
  }
});

// POST /api/vehicles/bulk-odometer - Bulk update odometers from CSV text
// Expects JSON { csv: "registration,odometer\nABC-123,50000\n..." }
router.post('/bulk-odometer', requireFleetManager, async (req: AuthRequest, res: Response) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') {
    res.status(400).json({ error: 'Missing or invalid csv string in body' });
    return;
  }

  const lines = csv.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  // Assuming header is first line, skip it if it contains "registration"
  if (lines.length > 0 && lines[0].toLowerCase().includes('registration')) {
    lines.shift();
  }

  const report = [];

  for (const line of lines) {
    const [registration, odometerStr] = line.split(',');
    if (!registration || !odometerStr) {
      report.push({ registration: registration || 'Unknown', success: false, reason: 'Invalid format' });
      continue;
    }

    const newOdometer = parseInt(odometerStr);
    if (isNaN(newOdometer)) {
      report.push({ registration, success: false, reason: 'Invalid odometer value' });
      continue;
    }

    try {
      const vehicle = await prisma.vehicle.findUnique({ where: { registration } });
      if (!vehicle) {
        report.push({ registration, success: false, reason: 'Vehicle not found' });
        continue;
      }

      if (newOdometer < vehicle.odometer) {
        report.push({ registration, success: false, reason: 'New reading is less than last recorded' });
        continue;
      }

      await prisma.vehicle.update({
        where: { registration },
        data: { odometer: newOdometer }
      });
      report.push({ registration, success: true });
    } catch (error) {
      console.error('Bulk update error:', error);
      report.push({ registration, success: false, reason: 'Database error' });
    }
  }

  res.json({ report });
});

// POST /api/vehicles - Create a vehicle (Fleet Manager only)
router.post('/', requireFleetManager, async (req: AuthRequest, res: Response) => {
  const { registration, make, model, odometer, dateIntervalDays, mileageInterval } = req.body;
  
  try {
    const initialOdometer = parseInt(odometer);
    const vehicle = await prisma.vehicle.create({
      data: {
        registration,
        make,
        model,
        odometer: initialOdometer,
        lastServiceMileage: initialOdometer,
        lastServiceDate: new Date(),
        serviceCycle: 1,
        dismissedAlertCycle: 0,
        dateIntervalDays: parseInt(dateIntervalDays),
        mileageInterval: parseInt(mileageInterval),
      }
    });
    res.status(201).json(vehicle);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create vehicle' });
  }
});

// PUT /api/vehicles/:id - Update a vehicle (Fleet Manager only)
router.put('/:id', requireFleetManager, async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { registration, make, model, odometer, dateIntervalDays, mileageInterval } = req.body;

  try {
    const vehicle = await prisma.vehicle.update({
      where: { id },
      data: {
        registration,
        make,
        model,
        odometer: odometer ? parseInt(odometer) : undefined,
        dateIntervalDays: dateIntervalDays ? parseInt(dateIntervalDays) : undefined,
        mileageInterval: mileageInterval ? parseInt(mileageInterval) : undefined,
      }
    });
    res.json(vehicle);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update vehicle' });
  }
});

// PATCH /api/vehicles/:id/archive - Archive/Restore a vehicle (Fleet Manager only)
router.patch('/:id/archive', requireFleetManager, async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { archived } = req.body;

  try {
    const vehicle = await prisma.vehicle.update({
      where: { id },
      data: { archived: Boolean(archived) }
    });
    res.json(vehicle);
  } catch (error) {
    res.status(400).json({ error: 'Failed to archive/restore vehicle' });
  }
});

export default router;
