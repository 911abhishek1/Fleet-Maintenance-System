import { ServiceLifecycleStatus } from './maintenance';

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export class ForbiddenActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenActionError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Strict map of allowed service lifecycle status transitions.
 * Linear lifecycle: DUE -> BOOKED -> IN_SERVICE -> COMPLETED.
 */
export const ALLOWED_TRANSITIONS: Record<ServiceLifecycleStatus, readonly ServiceLifecycleStatus[]> = {
  DUE: ['BOOKED'],
  BOOKED: ['IN_SERVICE'],
  IN_SERVICE: ['COMPLETED'],
  COMPLETED: [],
};

/**
 * Checks whether a given status transition is valid according to the domain state machine.
 */
export function isValidTransition(
  currentStatus: ServiceLifecycleStatus,
  nextStatus: ServiceLifecycleStatus
): boolean {
  if (currentStatus === nextStatus) {
    return true; // No status change is always allowed
  }
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(nextStatus) : false;
}

/**
 * Asserts that a transition from currentStatus to nextStatus is valid.
 * Throws InvalidTransitionError if invalid.
 */
export function assertValidTransition(
  currentStatus: ServiceLifecycleStatus,
  nextStatus: ServiceLifecycleStatus
): void {
  if (!isValidTransition(currentStatus, nextStatus)) {
    throw new InvalidTransitionError(
      `Invalid service status transition from '${currentStatus}' to '${nextStatus}'. ` +
      `Allowed next status: ${ALLOWED_TRANSITIONS[currentStatus]?.join(', ') || 'none (terminal)'}.`
    );
  }
}

export interface TransitionAuthContext {
  userRole: 'FLEET_MANAGER' | 'TECHNICIAN';
  userId: string;
  assignedUserIds: string[];
}

/**
 * Enforces role-based permissions and business requirements for each status transition:
 *
 * 1. DUE -> BOOKED:
 *    - Caller must be FLEET_MANAGER (Technicians cannot book).
 *    - Must have dateScheduled.
 *    - Must have at least one assigned technician.
 *
 * 2. BOOKED -> IN_SERVICE:
 *    - Caller must be FLEET_MANAGER or an assigned TECHNICIAN.
 *    - Unassigned technicians receive ForbiddenActionError.
 *
 * 3. IN_SERVICE -> COMPLETED:
 *    - Caller must be FLEET_MANAGER or an assigned TECHNICIAN.
 *    - Unassigned technicians receive ForbiddenActionError.
 *    - Must provide completedOdometer >= vehicle.odometer.
 */
export function assertTransitionAuthorized(
  fromStatus: ServiceLifecycleStatus,
  toStatus: ServiceLifecycleStatus,
  auth: TransitionAuthContext,
  data?: {
    dateScheduled?: Date | string | null;
    completedOdometer?: number | null;
    vehicleOdometer?: number;
  }
): void {
  if (fromStatus === toStatus) {
    // Non-status updates (e.g. updating description)
    if (auth.userRole === 'TECHNICIAN') {
      const isAssigned = auth.assignedUserIds.includes(auth.userId);
      if (!isAssigned) {
        throw new ForbiddenActionError('Forbidden: You are not assigned to this service record');
      }
    }
    return;
  }

  // 1. DUE -> BOOKED
  if (fromStatus === 'DUE' && toStatus === 'BOOKED') {
    if (auth.userRole !== 'FLEET_MANAGER') {
      throw new ForbiddenActionError('Forbidden: Only Fleet Managers can book a service record');
    }
    if (!data?.dateScheduled) {
      throw new ValidationError('Validation error: dateScheduled is required when booking a service');
    }
    if (!auth.assignedUserIds || auth.assignedUserIds.length === 0) {
      throw new ValidationError('Validation error: At least one technician must be assigned to book a service');
    }
    return;
  }

  // 2. BOOKED -> IN_SERVICE
  if (fromStatus === 'BOOKED' && toStatus === 'IN_SERVICE') {
    if (auth.userRole === 'TECHNICIAN') {
      const isAssigned = auth.assignedUserIds.includes(auth.userId);
      if (!isAssigned) {
        throw new ForbiddenActionError('Forbidden: You are not assigned to this service record');
      }
    }
    return;
  }

  // 3. IN_SERVICE -> COMPLETED
  if (fromStatus === 'IN_SERVICE' && toStatus === 'COMPLETED') {
    if (auth.userRole === 'TECHNICIAN') {
      const isAssigned = auth.assignedUserIds.includes(auth.userId);
      if (!isAssigned) {
        throw new ForbiddenActionError('Forbidden: You are not assigned to this service record');
      }
    }

    if (data?.completedOdometer === undefined || data.completedOdometer === null || !Number.isFinite(data.completedOdometer)) {
      throw new ValidationError('Validation error: completedOdometer is required when completing a service');
    }

    if (data.vehicleOdometer !== undefined && data.completedOdometer < data.vehicleOdometer) {
      throw new ValidationError(
        `Validation error: completedOdometer (${data.completedOdometer}) cannot be less than current vehicle odometer (${data.vehicleOdometer})`
      );
    }
    return;
  }
}
