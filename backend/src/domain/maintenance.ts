/**
 * Maintenance Trigger representing the threshold that caused a service to become due.
 */
export type MaintenanceTrigger = 'MILEAGE' | 'DATE' | 'NONE';

/**
 * Valid service lifecycle statuses (strictly four linear states).
 */
export type ServiceLifecycleStatus = 'DUE' | 'BOOKED' | 'IN_SERVICE' | 'COMPLETED';

/**
 * Core parameters of a vehicle required to calculate maintenance thresholds.
 * Kept strictly pure with zero database/framework dependencies.
 */
export interface VehicleMaintenanceInput {
  odometer: number;
  lastServiceDate: Date;
  lastServiceMileage: number;
  dateIntervalDays: number;
  mileageInterval: number;
}

/**
 * Detailed calculation result for service due evaluation.
 */
export interface ServiceDueEvaluation {
  isDue: boolean;
  trigger: MaintenanceTrigger;
  dateThreshold: Date;
  mileageThreshold: number;
  canonicalDueDate: Date | null;
  daysRemaining: number;
  kmRemaining: number;
}

/**
 * Input parameters for evaluating overdue condition on an existing service.
 */
export interface ServiceOverdueInput {
  status: ServiceLifecycleStatus;
  dueDate: Date | null;
  gracePeriodDays: number;
  evaluationTime?: Date;
}

const MS_PER_DAY = 86_400_000;

/**
 * Calculates the calendar date when the next service is due.
 *
 * @param lastServiceDate Baseline service or vehicle registration date
 * @param dateIntervalDays Allowed days between services (must be > 0)
 * @returns The Date threshold
 */
export function calculateDateThreshold(lastServiceDate: Date, dateIntervalDays: number): Date {
  if (dateIntervalDays <= 0 || !Number.isFinite(dateIntervalDays)) {
    throw new Error('Invalid dateIntervalDays: must be a positive integer');
  }
  return new Date(lastServiceDate.getTime() + Math.round(dateIntervalDays * MS_PER_DAY));
}

/**
 * Calculates the odometer mileage when the next service is due.
 *
 * @param lastServiceMileage Baseline mileage from last service or registration
 * @param mileageInterval Allowed mileage between services (must be > 0)
 * @returns The target odometer reading
 */
export function calculateMileageThreshold(lastServiceMileage: number, mileageInterval: number): number {
  if (mileageInterval <= 0 || !Number.isFinite(mileageInterval)) {
    throw new Error('Invalid mileageInterval: must be a positive integer');
  }
  return lastServiceMileage + mileageInterval;
}

/**
 * Evaluates whether a vehicle is currently due for maintenance based on its
 * mileage and calendar intervals.
 *
 * Rules:
 * 1. Mileage threshold: lastServiceMileage + mileageInterval
 * 2. Date threshold: lastServiceDate + dateIntervalDays
 * 3. Due when EITHER current odometer >= mileage threshold OR current time >= date threshold.
 *
 * Trigger Determination:
 * - 'MILEAGE' if only mileage threshold is reached. Canonical dueDate = evaluationTime (the time the odometer reading is observed).
 * - 'DATE' if only date threshold is reached. Canonical dueDate = dateThreshold.
 * - 'NONE' if neither threshold is reached. Canonical dueDate = null.
 * - If BOTH thresholds are reached: Deterministically resolved to 'DATE' with canonical dueDate = dateThreshold.
 *   Rationale: The calendar date threshold represents a fixed, known historical deadline (dateThreshold <= evaluationTime).
 *   Selecting the earlier threshold prevents granting an artificial extension to the grace period that would occur
 *   if reset to the current evaluation time.
 *
 * @param vehicle Vehicle maintenance parameters
 * @param evaluationTime Evaluation timestamp (defaults to new Date())
 * @returns ServiceDueEvaluation result
 */
export function evaluateServiceDue(
  vehicle: VehicleMaintenanceInput,
  evaluationTime?: Date
): ServiceDueEvaluation {
  // Validate intervals
  if (vehicle.dateIntervalDays <= 0 || !Number.isFinite(vehicle.dateIntervalDays)) {
    throw new Error('Invalid dateIntervalDays: must be a positive integer');
  }
  if (vehicle.mileageInterval <= 0 || !Number.isFinite(vehicle.mileageInterval)) {
    throw new Error('Invalid mileageInterval: must be a positive integer');
  }
  if (vehicle.odometer < vehicle.lastServiceMileage) {
    throw new Error('Invalid odometer: current odometer cannot be less than lastServiceMileage');
  }

  const now = evaluationTime ?? new Date();
  const dateThreshold = calculateDateThreshold(vehicle.lastServiceDate, vehicle.dateIntervalDays);
  const mileageThreshold = calculateMileageThreshold(vehicle.lastServiceMileage, vehicle.mileageInterval);

  const isMileageDue = vehicle.odometer >= mileageThreshold;
  const isDateDue = now.getTime() >= dateThreshold.getTime();
  const isDue = isMileageDue || isDateDue;

  let trigger: MaintenanceTrigger = 'NONE';
  let canonicalDueDate: Date | null = null;

  if (isMileageDue && isDateDue) {
    // Both thresholds reached: deterministic rule selects earlier timestamp (dateThreshold)
    trigger = 'DATE';
    canonicalDueDate = dateThreshold;
  } else if (isMileageDue) {
    trigger = 'MILEAGE';
    canonicalDueDate = now;
  } else if (isDateDue) {
    trigger = 'DATE';
    canonicalDueDate = dateThreshold;
  }

  const daysRemaining = Math.ceil((dateThreshold.getTime() - now.getTime()) / MS_PER_DAY);
  const kmRemaining = mileageThreshold - vehicle.odometer;

  return {
    isDue,
    trigger,
    dateThreshold,
    mileageThreshold,
    canonicalDueDate,
    daysRemaining,
    kmRemaining,
  };
}

/**
 * Determines whether an existing service record is overdue.
 *
 * Overdue is NOT a persisted lifecycle status. It is a derived temporal condition.
 *
 * Rules:
 * 1. Only services in 'DUE' or 'BOOKED' status can be overdue.
 * 2. Services in 'IN_SERVICE' or 'COMPLETED' are NEVER overdue.
 * 3. Future due dates (dueDate > now) are NEVER overdue.
 * 4. A service is overdue strictly when: now > dueDate + gracePeriodDays.
 * 5. Exactly on the grace-period boundary (now === dueDate + gracePeriodDays), it is NOT overdue.
 *
 * @param input Service parameters including status, dueDate, gracePeriodDays, and evaluationTime
 * @returns boolean
 */
export function isServiceOverdue(input: ServiceOverdueInput): boolean {
  const { status, dueDate, gracePeriodDays, evaluationTime } = input;

  // 1. Only DUE and BOOKED services can be overdue
  if (status !== 'DUE' && status !== 'BOOKED') {
    return false;
  }

  // 2. If no canonical dueDate exists, it cannot be overdue
  if (!dueDate) {
    return false;
  }

  // 3. Validate gracePeriodDays
  if (gracePeriodDays < 0 || !Number.isFinite(gracePeriodDays)) {
    throw new Error('Invalid gracePeriodDays: must be a non-negative number');
  }

  const now = evaluationTime ?? new Date();

  // 4. Future due dates are never overdue
  if (dueDate.getTime() > now.getTime()) {
    return false;
  }

  // 5. Calculate overdue cutoff without Math.abs
  const cutoffTime = dueDate.getTime() + (gracePeriodDays * MS_PER_DAY);

  // 6. Overdue strictly after the grace period cutoff
  return now.getTime() > cutoffTime;
}
