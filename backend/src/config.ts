/**
 * Application-wide configuration for maintenance and service alerts.
 */

/**
 * Parses and returns the configured grace period in days.
 * 
 * Rules:
 * - Finite non-negative values (>= 0) are accepted (including 0).
 * - Invalid, negative, or missing values fall back to default of 7 days.
 */
export function getOverdueGracePeriodDays(): number {
  const envVal = process.env.OVERDUE_GRACE_PERIOD_DAYS;
  if (envVal !== undefined && envVal !== null && envVal.trim() !== '') {
    const parsed = Number(envVal.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 7;
}

export const DEFAULT_GRACE_PERIOD_DAYS = getOverdueGracePeriodDays();
