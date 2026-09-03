import prisma from '../db';
import { ServiceLifecycleStatus } from '../domain/maintenance';
import {
  assertValidTransition,
  assertTransitionAuthorized,
  ValidationError,
  ForbiddenActionError,
} from '../domain/lifecycle';
import { logAuditEvent } from '../domain/audit';

export interface UpdateServiceLifecycleInput {
  status?: ServiceLifecycleStatus;
  description?: string;
  dateScheduled?: Date | string | null;
  completedOdometer?: number | null;
}

export interface CallerContext {
  id: string;
  role: 'FLEET_MANAGER' | 'TECHNICIAN';
}

/**
 * Executes a service record update or status transition according to strict lifecycle rules.
 * Status transitions and completions are wrapped in atomic database transactions.
 */
export async function updateServiceRecord(
  serviceRecordId: string,
  caller: CallerContext,
  input: UpdateServiceLifecycleInput
) {
  return await prisma.$transaction(async (tx) => {
    // 1. Read service record with vehicle and assignments
    const serviceRecord = await tx.serviceRecord.findUnique({
      where: { id: serviceRecordId },
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
    });

    if (!serviceRecord) {
      throw new ValidationError(`Service record '${serviceRecordId}' not found`);
    }

    const currentStatus = serviceRecord.status as ServiceLifecycleStatus;
    const targetStatus = (input.status ?? currentStatus) as ServiceLifecycleStatus;
    const assignedUserIds = serviceRecord.assignments.map((a) => a.userId);

    // 2. Validate state machine transition
    assertValidTransition(currentStatus, targetStatus);

    // 3. Verify authorization and business validation
    assertTransitionAuthorized(
      currentStatus,
      targetStatus,
      {
        userRole: caller.role,
        userId: caller.id,
        assignedUserIds,
      },
      {
        dateScheduled: input.dateScheduled,
        completedOdometer: input.completedOdometer,
        vehicleOdometer: serviceRecord.vehicle.odometer,
      }
    );

    // --- CASE A: Completion (IN_SERVICE -> COMPLETED) ---
    if (targetStatus === 'COMPLETED' && currentStatus === 'IN_SERVICE') {
      const completionTime = new Date();
      const completedOdometer = Number(input.completedOdometer);

      // Update Service Record
      const updatedService = await tx.serviceRecord.update({
        where: { id: serviceRecord.id },
        data: {
          status: 'COMPLETED',
          dateCompleted: completionTime,
          completedOdometer,
          description: input.description ?? serviceRecord.description,
        },
        include: {
          vehicle: true,
          assignments: {
            include: { user: { select: { id: true, email: true, role: true } } },
          },
        },
      });

      // Update Vehicle baselines and increment cycle in the same transaction
      const previousCycle = serviceRecord.vehicle.serviceCycle;
      const updatedVehicle = await tx.vehicle.update({
        where: { id: serviceRecord.vehicleId },
        data: {
          odometer: completedOdometer,
          lastServiceDate: completionTime,
          lastServiceMileage: completedOdometer,
          serviceCycle: previousCycle + 1,
        },
      });

      // Create Audit Log for Service Completion
      await logAuditEvent(tx, {
        serviceRecordId: serviceRecord.id,
        vehicleId: serviceRecord.vehicleId,
        changedById: caller.id,
        action: 'SERVICE_COMPLETED',
        field: 'status',
        oldValue: currentStatus,
        newValue: 'COMPLETED',
        notes: `Completed cycle ${serviceRecord.cycle} at odometer ${completedOdometer} km. ${input.description ? `Notes: ${input.description}` : ''}`.trim(),
      });

      // Create Audit Log for Vehicle Baseline Reset & Cycle Increment
      await logAuditEvent(tx, {
        vehicleId: serviceRecord.vehicleId,
        serviceRecordId: serviceRecord.id,
        changedById: caller.id,
        action: 'VEHICLE_BASELINES_RESET',
        field: 'serviceCycle',
        oldValue: String(previousCycle),
        newValue: String(previousCycle + 1),
        notes: `Baselines reset to odometer ${completedOdometer} km, date ${completionTime.toISOString()}`,
      });

      return { service: updatedService, vehicle: updatedVehicle };
    }

    // --- CASE B: Booking (DUE -> BOOKED) ---
    if (targetStatus === 'BOOKED' && currentStatus === 'DUE') {
      const scheduledDate = new Date(input.dateScheduled!);

      const updatedService = await tx.serviceRecord.update({
        where: { id: serviceRecord.id },
        data: {
          status: 'BOOKED',
          dateScheduled: scheduledDate,
          description: input.description ?? serviceRecord.description,
        },
        include: {
          vehicle: true,
          assignments: {
            include: { user: { select: { id: true, email: true, role: true } } },
          },
        },
      });

      await logAuditEvent(tx, {
        serviceRecordId: serviceRecord.id,
        vehicleId: serviceRecord.vehicleId,
        changedById: caller.id,
        action: 'SERVICE_BOOKED',
        field: 'status',
        oldValue: 'DUE',
        newValue: 'BOOKED',
        notes: `Scheduled for ${scheduledDate.toISOString()} with ${assignedUserIds.length} technician(s) assigned`,
      });

      return { service: updatedService, vehicle: serviceRecord.vehicle };
    }

    // --- CASE C: Starting Work (BOOKED -> IN_SERVICE) ---
    if (targetStatus === 'IN_SERVICE' && currentStatus === 'BOOKED') {
      const updatedService = await tx.serviceRecord.update({
        where: { id: serviceRecord.id },
        data: {
          status: 'IN_SERVICE',
          description: input.description ?? serviceRecord.description,
        },
        include: {
          vehicle: true,
          assignments: {
            include: { user: { select: { id: true, email: true, role: true } } },
          },
        },
      });

      await logAuditEvent(tx, {
        serviceRecordId: serviceRecord.id,
        vehicleId: serviceRecord.vehicleId,
        changedById: caller.id,
        action: 'SERVICE_STARTED',
        field: 'status',
        oldValue: 'BOOKED',
        newValue: 'IN_SERVICE',
        notes: input.description ?? undefined,
      });

      return { service: updatedService, vehicle: serviceRecord.vehicle };
    }

    // --- CASE D: Same Status Description/Notes Update ---
    const updateData: { description?: string; dateScheduled?: Date } = {};
    if (input.description !== undefined) {
      updateData.description = input.description;
    }
    if (input.dateScheduled && caller.role === 'FLEET_MANAGER') {
      updateData.dateScheduled = new Date(input.dateScheduled);
    }

    const updatedService = await tx.serviceRecord.update({
      where: { id: serviceRecord.id },
      data: updateData,
      include: {
        vehicle: true,
        assignments: {
          include: { user: { select: { id: true, email: true, role: true } } },
        },
      },
    });

    if (input.description && input.description !== serviceRecord.description) {
      await logAuditEvent(tx, {
        serviceRecordId: serviceRecord.id,
        vehicleId: serviceRecord.vehicleId,
        changedById: caller.id,
        action: 'SERVICE_UPDATED',
        field: 'description',
        oldValue: serviceRecord.description,
        newValue: input.description,
      });
    }

    return { service: updatedService, vehicle: serviceRecord.vehicle };
  });
}
