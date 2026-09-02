import { Router, Response } from 'express';
import { requireAuth, requireFleetManager, AuthRequest } from '../middleware/auth';
import prisma from '../db';

const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

// GET /api/vehicles - List all vehicles
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      include: {
        serviceRecords: true
      }
    });
    res.json(vehicles);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/vehicles/evaluate-status - Auto-flag DUE and OVERDUE
// Typically called by a background cron job
router.post('/evaluate-status', requireFleetManager, async (req: AuthRequest, res: Response) => {
  const { gracePeriodDays = 7 } = req.body;
  
  try {
    const vehicles = await prisma.vehicle.findMany({
      include: {
        serviceRecords: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    const now = new Date();
    let flaggedDue = 0;
    let flaggedOverdue = 0;

    for (const vehicle of vehicles) {
      // Find the last completed service to calculate intervals, or the latest active service
      const lastCompleted = vehicle.serviceRecords.find(r => r.status === 'COMPLETED');
      const currentActive = vehicle.serviceRecords.find(r => r.status !== 'COMPLETED');
      
      // If there's an active service (DUE, OVERDUE, BOOKED, IN_SERVICE), check if we need to mark it OVERDUE
      if (currentActive && currentActive.status === 'DUE') {
        const dueDate = currentActive.createdAt; // Assuming it became DUE on creation, or we can use dateScheduled
        const diffTime = Math.abs(now.getTime() - dueDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays > gracePeriodDays) {
          await prisma.serviceRecord.update({
            where: { id: currentActive.id },
            data: { status: 'OVERDUE' }
          });
          flaggedOverdue++;
        }
        continue;
      }

      // If no active service, check if we need to create a new DUE service
      if (!currentActive) {
        let isDue = false;

        // Based on mileage
        const lastOdometer = lastCompleted?.completedOdometer || 0;
        if (vehicle.odometer - lastOdometer >= vehicle.mileageInterval) {
          isDue = true;
        }

        // Based on date
        const lastDate = lastCompleted?.dateCompleted || vehicle.createdAt;
        const diffTimeDate = Math.abs(now.getTime() - lastDate.getTime());
        const diffDaysDate = Math.ceil(diffTimeDate / (1000 * 60 * 60 * 24));
        if (diffDaysDate >= vehicle.dateIntervalDays) {
          isDue = true;
        }

        if (isDue) {
          await prisma.serviceRecord.create({
            data: {
              vehicleId: vehicle.id,
              description: 'Auto-flagged regular maintenance',
              status: 'DUE'
            }
          });
          flaggedDue++;
        }
      }
    }

    res.json({ message: 'Evaluation complete', flaggedDue, flaggedOverdue });
  } catch (error) {
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
    const vehicle = await prisma.vehicle.create({
      data: {
        registration,
        make,
        model,
        odometer: parseInt(odometer),
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
  const { id } = req.params;
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
  const { id } = req.params;
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
