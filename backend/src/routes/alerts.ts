import { Router, Response } from 'express';
import { requireAuth, requireFleetManager, AuthRequest } from '../middleware/auth';
import prisma from '../db';
import { isServiceOverdue } from '../domain/maintenance';
import { logAuditEvent } from '../domain/audit';
import { getOverdueGracePeriodDays } from '../config';

const router = Router();
router.use(requireAuth);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// GET /api/alerts - List currently active overdue service alerts
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.id;
    const gracePeriodDays = getOverdueGracePeriodDays();
    const now = new Date();

    const where: any = {
      status: { in: ['DUE', 'BOOKED'] },
      dueDate: { not: null },
      vehicle: { archived: false },
    };

    // Scoping: Technicians are strictly locked to their assigned service records
    if (userRole === 'TECHNICIAN') {
      where.assignments = {
        some: { userId },
      };
    }

    const records = await prisma.serviceRecord.findMany({
      where,
      include: {
        vehicle: true,
        assignments: {
          include: {
            user: {
              select: { id: true, email: true, role: true },
            },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    const activeAlerts = [];

    for (const record of records) {
      if (!record.dueDate) continue;

      // 1. Evaluate pure overdue rule
      const overdue = isServiceOverdue({
        status: record.status,
        dueDate: record.dueDate,
        gracePeriodDays,
        evaluationTime: now,
      });

      if (!overdue) continue;

      // 2. Alert visible only if not dismissed for this current service cycle
      if (record.vehicle.dismissedAlertCycle === record.vehicle.serviceCycle) {
        continue;
      }

      const cutoffTime = record.dueDate.getTime() + (gracePeriodDays * MS_PER_DAY);
      const daysOverdue = Math.max(0, Math.floor((now.getTime() - cutoffTime) / MS_PER_DAY));

      activeAlerts.push({
        id: record.id,
        serviceRecordId: record.id,
        status: record.status,
        description: record.description,
        dueDate: record.dueDate,
        cycle: record.cycle,
        overdueCutoff: new Date(cutoffTime),
        daysOverdue,
        vehicle: {
          id: record.vehicle.id,
          registration: record.vehicle.registration,
          make: record.vehicle.make,
          model: record.vehicle.model,
          serviceCycle: record.vehicle.serviceCycle,
          dismissedAlertCycle: record.vehicle.dismissedAlertCycle,
        },
        registration: record.vehicle.registration,
        technicians: record.assignments.map((a) => a.user.email),
      });
    }

    res.json({
      alerts: activeAlerts,
      count: activeAlerts.length,
    });
  } catch (error) {
    console.error('Failed to list alerts:', error);
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

// POST /api/alerts/:serviceRecordId/dismiss - Dismiss alert for current cycle (Fleet Manager only)
router.post('/:serviceRecordId/dismiss', requireFleetManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const serviceRecordId = String(req.params.serviceRecordId);

  try {
    const record = await prisma.serviceRecord.findUnique({
      where: { id: serviceRecordId },
      include: { vehicle: true },
    });

    if (!record) {
      res.status(404).json({ error: 'Service record not found' });
      return;
    }

    // 1. Verify service record is currently overdue
    const gracePeriodDays = getOverdueGracePeriodDays();
    const overdue = isServiceOverdue({
      status: record.status,
      dueDate: record.dueDate,
      gracePeriodDays,
      evaluationTime: new Date(),
    });

    if (!overdue) {
      res.status(400).json({ error: 'Cannot dismiss alert: service record is not currently overdue' });
      return;
    }

    // 2. Verify alert has not already been dismissed for this cycle
    if (record.vehicle.dismissedAlertCycle === record.vehicle.serviceCycle) {
      res.status(400).json({ error: 'Alert is already dismissed for the current service cycle' });
      return;
    }

    // 3. Atomically update dismissedAlertCycle and record audit log
    await prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: record.vehicleId },
        data: { dismissedAlertCycle: record.vehicle.serviceCycle },
      });

      await logAuditEvent(tx, {
        vehicleId: record.vehicleId,
        serviceRecordId: record.id,
        changedById: req.user!.id,
        action: 'ALERT_DISMISSED',
        field: 'dismissedAlertCycle',
        oldValue: String(record.vehicle.dismissedAlertCycle),
        newValue: String(record.vehicle.serviceCycle),
        notes: `Overdue alert dismissed for service cycle ${record.vehicle.serviceCycle}`,
      });
    });

    res.json({
      message: 'Alert dismissed for the current service cycle',
      serviceRecordId: record.id,
      vehicleId: record.vehicleId,
      dismissedAlertCycle: record.vehicle.serviceCycle,
    });
  } catch (error) {
    console.error('Failed to dismiss alert:', error);
    res.status(500).json({ error: 'Failed to dismiss alert' });
  }
});

export default router;
