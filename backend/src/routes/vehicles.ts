import { Router, Response } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { requireAuth, requireFleetManager, AuthRequest } from '../middleware/auth';
import prisma from '../db';
import { evaluateServiceDue } from '../domain/maintenance';
import { logAuditEvent } from '../domain/audit';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit
});

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

// POST /api/vehicles/bulk-odometer - Bulk update odometers from uploaded CSV file (Fleet Manager only)
router.post('/bulk-odometer', requireFleetManager, upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  let csvContent = '';
  if (req.file) {
    csvContent = req.file.buffer.toString('utf-8');
  } else if (req.body && typeof req.body.csv === 'string') {
    csvContent = req.body.csv;
  }

  if (!csvContent || !csvContent.trim()) {
    res.status(400).json({ error: 'No CSV file or content provided' });
    return;
  }

  let records: string[][];
  try {
    records = parse(csvContent, {
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (parseErr: any) {
    res.status(400).json({ error: `Malformed CSV content: ${parseErr.message || 'Parse error'}` });
    return;
  }

  if (records.length === 0) {
    res.json({ report: [] });
    return;
  }

  // Detect header row
  let startIndex = 0;
  const firstRow = records[0];
  const col0 = (firstRow[0] || '').toLowerCase().trim();
  const col1 = (firstRow[1] || '').toLowerCase().trim();
  if (
    col0.includes('reg') ||
    col0.includes('veh') ||
    col0.includes('identifier') ||
    col0.includes('id') ||
    col1.includes('odo') ||
    col1.includes('reading') ||
    col1.includes('mileage')
  ) {
    startIndex = 1;
  }

  const report: Array<{
    rowNumber: number;
    vehicleIdentifier: string;
    inputOdometer: number | string;
    status: 'SUCCESS' | 'REJECTED';
    success: boolean;
    reason: string | null;
  }> = [];

  // In-memory tracker for sequential duplicate rows within this file
  const inMemoryOdometerMap = new Map<string, number>();

  for (let i = startIndex; i < records.length; i++) {
    const rowNumber = i + 1; // 1-indexed file row
    const row = records[i];

    // 1. Validate row structure
    if (!row || row.length < 2) {
      report.push({
        rowNumber,
        vehicleIdentifier: row?.[0] || 'Unknown',
        inputOdometer: row?.[1] ?? '',
        status: 'REJECTED',
        success: false,
        reason: 'Malformed row: expected at least 2 columns (vehicle identifier, odometer)',
      });
      continue;
    }

    const vehicleIdentifier = (row[0] || '').trim();
    const odometerRaw = (row[1] || '').trim();

    if (!vehicleIdentifier) {
      report.push({
        rowNumber,
        vehicleIdentifier: '',
        inputOdometer: odometerRaw,
        status: 'REJECTED',
        success: false,
        reason: 'Vehicle identifier is required',
      });
      continue;
    }

    // 2. Validate odometer value
    const num = Number(odometerRaw);
    if (odometerRaw === '' || isNaN(num) || !Number.isInteger(num) || num < 0) {
      report.push({
        rowNumber,
        vehicleIdentifier,
        inputOdometer: odometerRaw,
        status: 'REJECTED',
        success: false,
        reason: 'Invalid odometer: must be a non-negative integer',
      });
      continue;
    }

    // 3. Identify vehicle
    try {
      const vehicle = await prisma.vehicle.findFirst({
        where: {
          OR: [
            { registration: vehicleIdentifier },
            { id: vehicleIdentifier },
          ],
        },
      });

      if (!vehicle) {
        report.push({
          rowNumber,
          vehicleIdentifier,
          inputOdometer: num,
          status: 'REJECTED',
          success: false,
          reason: 'Vehicle not found',
        });
        continue;
      }

      // 4. Sequential duplicate row check against in-file latest value
      const latestTracked = inMemoryOdometerMap.get(vehicle.id) ?? vehicle.odometer;
      if (num < latestTracked) {
        report.push({
          rowNumber,
          vehicleIdentifier,
          inputOdometer: num,
          status: 'REJECTED',
          success: false,
          reason: `New reading (${num}) is lower than previous recorded reading (${latestTracked})`,
        });
        continue;
      }

      // 5. Atomic per-row update with database re-read concurrency check and audit logging
      let currentDbOdometer = vehicle.odometer;
      await prisma.$transaction(async (tx) => {
        const freshVehicle = await tx.vehicle.findUnique({
          where: { id: vehicle.id },
          select: { id: true, odometer: true },
        });

        if (!freshVehicle) {
          throw new Error('Vehicle not found during transaction');
        }

        if (num < freshVehicle.odometer) {
          throw new Error(`Concurrent update: database odometer (${freshVehicle.odometer}) is higher than new reading (${num})`);
        }

        currentDbOdometer = freshVehicle.odometer;

        await tx.vehicle.update({
          where: { id: vehicle.id },
          data: { odometer: num },
        });

        await logAuditEvent(tx, {
          vehicleId: vehicle.id,
          changedById: req.user?.id,
          action: 'ODOMETER_UPDATED',
          field: 'odometer',
          oldValue: String(currentDbOdometer),
          newValue: String(num),
          notes: `Bulk odometer CSV import: updated from ${currentDbOdometer} to ${num} (row ${rowNumber})`,
        });
      });

      // Update in-memory tracker after successful transaction commit
      inMemoryOdometerMap.set(vehicle.id, num);

      report.push({
        rowNumber,
        vehicleIdentifier,
        inputOdometer: num,
        status: 'SUCCESS',
        success: true,
        reason: null,
      });
    } catch (err: any) {
      report.push({
        rowNumber,
        vehicleIdentifier,
        inputOdometer: num,
        status: 'REJECTED',
        success: false,
        reason: err.message || 'Failed to update vehicle odometer',
      });
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
