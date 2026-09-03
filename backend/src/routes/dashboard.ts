import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import prisma from '../db';
import { evaluateServiceDue, isServiceOverdue, ServiceLifecycleStatus } from '../domain/maintenance';
import { getOverdueGracePeriodDays } from '../config';

const router = Router();
router.use(requireAuth);

/**
 * Returns start of calendar week (Monday 00:00:00.000)
 */
export function getStartOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0 is Sunday, 1 is Monday, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns end of calendar week (Sunday 23:59:59.999)
 */
export function getEndOfWeek(date: Date): Date {
  const start = getStartOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * Builds array of the latest 8 calendar weeks ending with the current week.
 * Chronologically sorted (index 0 is oldest, index 7 is current).
 */
export function getLatest8Weeks(now: Date) {
  const currentStart = getStartOfWeek(now);
  const weeks: Array<{
    weekIndex: number;
    weekLabel: string;
    startDate: string;
    endDate: string;
    count: number;
  }> = [];

  for (let i = 7; i >= 0; i--) {
    const wStart = new Date(currentStart);
    wStart.setDate(wStart.getDate() - i * 7);
    wStart.setHours(0, 0, 0, 0);

    const wEnd = new Date(wStart);
    wEnd.setDate(wEnd.getDate() + 6);
    wEnd.setHours(23, 59, 59, 999);

    const startLabel = wStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endLabel = wEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const weekLabel = i === 0 ? `This Week (${startLabel})` : `${startLabel} - ${endLabel}`;

    weeks.push({
      weekIndex: 7 - i,
      weekLabel,
      startDate: wStart.toISOString(),
      endDate: wEnd.toISOString(),
      count: 0,
    });
  }

  return weeks;
}

// GET /api/dashboard - Fleet Maintenance Dashboard metrics
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.id;
    const isTechnician = userRole === 'TECHNICIAN';
    const now = new Date();
    const gracePeriodDays = getOverdueGracePeriodDays();

    const currentStart = getStartOfWeek(now);
    const currentEnd = getEndOfWeek(now);
    const weeks = getLatest8Weeks(now);

    // 1. vehiclesDue
    // Vehicles whose current maintenance condition is due via evaluateServiceDue.
    // Respects archived (archived: false).
    // For technician, evaluates only vehicles assigned to that technician.
    const vehicleWhere: any = {
      archived: false,
    };
    if (isTechnician) {
      vehicleWhere.serviceRecords = {
        some: {
          assignments: {
            some: { userId },
          },
        },
      };
    }

    const candidateVehicles = await prisma.vehicle.findMany({
      where: vehicleWhere,
      select: {
        id: true,
        odometer: true,
        lastServiceDate: true,
        lastServiceMileage: true,
        dateIntervalDays: true,
        mileageInterval: true,
      },
    });

    let vehiclesDue = 0;
    for (const v of candidateVehicles) {
      try {
        const evalRes = evaluateServiceDue(
          {
            odometer: v.odometer,
            lastServiceDate: v.lastServiceDate,
            lastServiceMileage: v.lastServiceMileage,
            dateIntervalDays: v.dateIntervalDays,
            mileageInterval: v.mileageInterval,
          },
          now
        );
        if (evalRes.isDue) {
          vehiclesDue++;
        }
      } catch {
        // Ignore vehicles with irregular data
      }
    }

    // 2. vehiclesInService
    // Count of distinct vehicles having an active IN_SERVICE record (archived: false)
    const vehiclesInService = await prisma.vehicle.count({
      where: {
        archived: false,
        serviceRecords: {
          some: {
            status: 'IN_SERVICE',
            ...(isTechnician ? { assignments: { some: { userId } } } : {}),
          },
        },
      },
    });

    // 3. completedThisWeek
    // Service records completed during the current calendar week (archived: false)
    const completedThisWeek = await prisma.serviceRecord.count({
      where: {
        status: 'COMPLETED',
        dateCompleted: {
          gte: currentStart,
          lte: currentEnd,
        },
        vehicle: {
          archived: false,
        },
        ...(isTechnician ? { assignments: { some: { userId } } } : {}),
      },
    });

    // 4. overdue
    // Active overdue service alerts/records using isServiceOverdue logic (archived: false)
    const candidateOverdueRecords = await prisma.serviceRecord.findMany({
      where: {
        status: { in: ['DUE', 'BOOKED'] },
        dueDate: { not: null },
        vehicle: { archived: false },
        ...(isTechnician ? { assignments: { some: { userId } } } : {}),
      },
      select: {
        id: true,
        status: true,
        dueDate: true,
        vehicle: {
          select: {
            serviceCycle: true,
            dismissedAlertCycle: true,
          },
        },
      },
    });

    let overdue = 0;
    for (const r of candidateOverdueRecords) {
      const isOverdue = isServiceOverdue({
        status: r.status as ServiceLifecycleStatus,
        dueDate: r.dueDate,
        gracePeriodDays,
        evaluationTime: now,
      });
      if (isOverdue && r.vehicle.dismissedAlertCycle !== r.vehicle.serviceCycle) {
        overdue++;
      }
    }

    // 5. statusBreakdown
    // Counts by the 4 lifecycle statuses only: DUE, BOOKED, IN_SERVICE, COMPLETED
    const statusCounts = await prisma.serviceRecord.groupBy({
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        vehicle: {
          archived: false,
        },
        ...(isTechnician ? { assignments: { some: { userId } } } : {}),
      },
    });

    const statusBreakdown = {
      DUE: 0,
      BOOKED: 0,
      IN_SERVICE: 0,
      COMPLETED: 0,
    };

    for (const row of statusCounts) {
      if (row.status in statusBreakdown) {
        statusBreakdown[row.status as keyof typeof statusBreakdown] = row._count._all;
      }
    }

    // 6. technicianBreakdown
    // Grouped by technician, respecting caller scope (Technicians only see themselves)
    let technicianBreakdown: Array<{
      technicianId: string;
      email: string;
      totalAssigned: number;
      inService: number;
      completed: number;
      statusBreakdown: {
        DUE: number;
        BOOKED: number;
        IN_SERVICE: number;
        COMPLETED: number;
      };
    }> = [];

    if (isTechnician) {
      const technicianUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          assignments: {
            where: {
              serviceRecord: {
                vehicle: { archived: false },
              },
            },
            select: {
              serviceRecord: {
                select: {
                  status: true,
                },
              },
            },
          },
        },
      });

      if (technicianUser) {
        const counts = { DUE: 0, BOOKED: 0, IN_SERVICE: 0, COMPLETED: 0 };
        for (const a of technicianUser.assignments) {
          const s = a.serviceRecord.status as keyof typeof counts;
          if (s in counts) counts[s]++;
        }
        technicianBreakdown = [
          {
            technicianId: technicianUser.id,
            email: technicianUser.email,
            totalAssigned: technicianUser.assignments.length,
            inService: counts.IN_SERVICE,
            completed: counts.COMPLETED,
            statusBreakdown: counts,
          },
        ];
      }
    } else {
      const technicians = await prisma.user.findMany({
        where: { role: 'TECHNICIAN' },
        select: {
          id: true,
          email: true,
          assignments: {
            where: {
              serviceRecord: {
                vehicle: { archived: false },
              },
            },
            select: {
              serviceRecord: {
                select: {
                  status: true,
                },
              },
            },
          },
        },
        orderBy: { email: 'asc' },
      });

      technicianBreakdown = technicians.map((t) => {
        const counts = { DUE: 0, BOOKED: 0, IN_SERVICE: 0, COMPLETED: 0 };
        for (const a of t.assignments) {
          const s = a.serviceRecord.status as keyof typeof counts;
          if (s in counts) counts[s]++;
        }
        return {
          technicianId: t.id,
          email: t.email,
          totalAssigned: t.assignments.length,
          inService: counts.IN_SERVICE,
          completed: counts.COMPLETED,
          statusBreakdown: counts,
        };
      });
    }

    // 7. completedLast8Weeks
    // Weekly completed service counts for latest 8 calendar weeks, including 0-count weeks
    const completedRecords = await prisma.serviceRecord.findMany({
      where: {
        status: 'COMPLETED',
        dateCompleted: {
          gte: new Date(weeks[0].startDate),
          lte: new Date(weeks[7].endDate),
        },
        vehicle: {
          archived: false,
        },
        ...(isTechnician ? { assignments: { some: { userId } } } : {}),
      },
      select: {
        dateCompleted: true,
      },
    });

    for (const rec of completedRecords) {
      if (!rec.dateCompleted) continue;
      const t = rec.dateCompleted.getTime();
      for (const w of weeks) {
        if (t >= new Date(w.startDate).getTime() && t <= new Date(w.endDate).getTime()) {
          w.count++;
          break;
        }
      }
    }

    res.json({
      vehiclesDue,
      vehiclesInService,
      completedThisWeek,
      overdue,
      statusBreakdown,
      technicianBreakdown,
      completedLast8Weeks: weeks,
    });
  } catch (error) {
    console.error('Failed to generate dashboard metrics:', error);
    res.status(500).json({ error: 'Internal server error generating dashboard' });
  }
});

export default router;
