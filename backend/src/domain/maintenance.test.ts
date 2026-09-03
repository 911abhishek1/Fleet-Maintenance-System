import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDateThreshold,
  calculateMileageThreshold,
  evaluateServiceDue,
  isServiceOverdue,
  VehicleMaintenanceInput,
} from './maintenance';

describe('Maintenance Calculation Domain Rules', () => {
  const BASE_DATE = new Date('2026-01-01T00:00:00.000Z');
  const MS_PER_DAY = 86_400_000;

  describe('Threshold Calculations', () => {
    it('calculates date threshold accurately', () => {
      const threshold = calculateDateThreshold(BASE_DATE, 180);
      const expected = new Date(BASE_DATE.getTime() + 180 * MS_PER_DAY);
      assert.equal(threshold.toISOString(), expected.toISOString());
    });

    it('calculates mileage threshold accurately', () => {
      const threshold = calculateMileageThreshold(50_000, 10_000);
      assert.equal(threshold, 60_000);
    });

    it('rejects zero or negative date intervals', () => {
      assert.throws(() => calculateDateThreshold(BASE_DATE, 0), /Invalid dateIntervalDays/);
      assert.throws(() => calculateDateThreshold(BASE_DATE, -10), /Invalid dateIntervalDays/);
    });

    it('rejects zero or negative mileage intervals', () => {
      assert.throws(() => calculateMileageThreshold(50_000, 0), /Invalid mileageInterval/);
      assert.throws(() => calculateMileageThreshold(50_000, -5_000), /Invalid mileageInterval/);
    });
  });

  describe('Service Due Evaluations', () => {
    // Standard vehicle baseline: 50,000 km, 180 days interval, 10,000 km interval
    const standardVehicle: VehicleMaintenanceInput = {
      odometer: 50_000,
      lastServiceDate: BASE_DATE,
      lastServiceMileage: 50_000,
      dateIntervalDays: 180,
      mileageInterval: 10_000,
    };

    it('Test 1: Neither threshold reached -> Not due', () => {
      const now = new Date(BASE_DATE.getTime() + 30 * MS_PER_DAY); // 30 days in
      const result = evaluateServiceDue(
        { ...standardVehicle, odometer: 54_000 },
        now
      );

      assert.equal(result.isDue, false);
      assert.equal(result.trigger, 'NONE');
      assert.equal(result.canonicalDueDate, null);
      assert.equal(result.kmRemaining, 6_000);
      assert.equal(result.daysRemaining, 150);
    });

    it('Test 2: Mileage threshold reached first -> Due by MILEAGE', () => {
      const now = new Date(BASE_DATE.getTime() + 60 * MS_PER_DAY); // 60 days in (< 180)
      const result = evaluateServiceDue(
        { ...standardVehicle, odometer: 61_500 }, // > 60,000
        now
      );

      assert.equal(result.isDue, true);
      assert.equal(result.trigger, 'MILEAGE');
      assert.equal(result.canonicalDueDate?.toISOString(), now.toISOString());
      assert.equal(result.kmRemaining, -1_500);
      assert.equal(result.daysRemaining, 120);
    });

    it('Test 3: Date threshold reached first -> Due by DATE', () => {
      const now = new Date(BASE_DATE.getTime() + 195 * MS_PER_DAY); // 195 days in (> 180)
      const dateThreshold = new Date(BASE_DATE.getTime() + 180 * MS_PER_DAY);
      const result = evaluateServiceDue(
        { ...standardVehicle, odometer: 53_000 }, // < 60,000
        now
      );

      assert.equal(result.isDue, true);
      assert.equal(result.trigger, 'DATE');
      assert.equal(result.canonicalDueDate?.toISOString(), dateThreshold.toISOString());
      assert.equal(result.kmRemaining, 7_000);
      assert.equal(result.daysRemaining, -15);
    });

    it('Test 4: Both thresholds reached -> Due by DATE (earlier historical deadline)', () => {
      const now = new Date(BASE_DATE.getTime() + 200 * MS_PER_DAY); // > 180 days
      const dateThreshold = new Date(BASE_DATE.getTime() + 180 * MS_PER_DAY);
      const result = evaluateServiceDue(
        { ...standardVehicle, odometer: 63_000 }, // > 60,000 km
        now
      );

      assert.equal(result.isDue, true);
      assert.equal(result.trigger, 'DATE');
      // Must use earlier threshold timestamp (dateThreshold <= now)
      assert.equal(result.canonicalDueDate?.toISOString(), dateThreshold.toISOString());
      assert.ok(result.canonicalDueDate!.getTime() < now.getTime());
    });

    it('Test 5: Exact mileage threshold reached -> Due by MILEAGE', () => {
      const now = new Date(BASE_DATE.getTime() + 50 * MS_PER_DAY);
      const result = evaluateServiceDue(
        { ...standardVehicle, odometer: 60_000 }, // Exactly 50,000 + 10,000
        now
      );

      assert.equal(result.isDue, true);
      assert.equal(result.trigger, 'MILEAGE');
      assert.equal(result.kmRemaining, 0);
      assert.equal(result.canonicalDueDate?.toISOString(), now.toISOString());
    });

    it('Test 6: Exact date threshold reached -> Due by DATE', () => {
      const exactDate = new Date(BASE_DATE.getTime() + 180 * MS_PER_DAY);
      const result = evaluateServiceDue(
        { ...standardVehicle, odometer: 55_000 },
        exactDate
      );

      assert.equal(result.isDue, true);
      assert.equal(result.trigger, 'DATE');
      assert.equal(result.daysRemaining, 0);
      assert.equal(result.canonicalDueDate?.toISOString(), exactDate.toISOString());
    });

    it('Test 10: Zero or invalid intervals throw validation error', () => {
      assert.throws(
        () => evaluateServiceDue({ ...standardVehicle, dateIntervalDays: 0 }),
        /Invalid dateIntervalDays/
      );
      assert.throws(
        () => evaluateServiceDue({ ...standardVehicle, mileageInterval: -100 }),
        /Invalid mileageInterval/
      );
      assert.throws(
        () => evaluateServiceDue({ ...standardVehicle, odometer: 40_000, lastServiceMileage: 50_000 }),
        /odometer cannot be less than lastServiceMileage/
      );
    });

    it('Test 11: Current odometer equal to baseline -> Not due', () => {
      const now = new Date(BASE_DATE.getTime() + 10 * MS_PER_DAY);
      const result = evaluateServiceDue(
        { ...standardVehicle, odometer: 50_000, lastServiceMileage: 50_000 },
        now
      );

      assert.equal(result.isDue, false);
      assert.equal(result.trigger, 'NONE');
      assert.equal(result.kmRemaining, 10_000);
    });

    it('Test 12: Newly created vehicle with realistic odometer is NOT immediately due', () => {
      // Vehicle registered with 50,000 km initial odometer
      const registrationDate = new Date('2026-09-01T10:00:00.000Z');
      const newlyCreatedVehicle: VehicleMaintenanceInput = {
        odometer: 50_000,
        lastServiceDate: registrationDate,
        lastServiceMileage: 50_000, // Initial baseline equals initial odometer
        dateIntervalDays: 180,
        mileageInterval: 10_000,
      };

      // Evaluation at creation moment
      const atCreation = evaluateServiceDue(newlyCreatedVehicle, registrationDate);
      assert.equal(atCreation.isDue, false);
      assert.equal(atCreation.trigger, 'NONE');
      assert.equal(atCreation.kmRemaining, 10_000);
      assert.equal(atCreation.daysRemaining, 180);

      // Evaluation 1 month later with 3,000 km driven
      const oneMonthLater = new Date(registrationDate.getTime() + 30 * MS_PER_DAY);
      const laterEval = evaluateServiceDue(
        { ...newlyCreatedVehicle, odometer: 53_000 },
        oneMonthLater
      );
      assert.equal(laterEval.isDue, false);
      assert.equal(laterEval.trigger, 'NONE');
      assert.equal(laterEval.kmRemaining, 7_000);
      assert.equal(laterEval.daysRemaining, 150);
    });
  });

  describe('Overdue Condition Evaluations', () => {
    const DUE_DATE = new Date('2026-03-01T00:00:00.000Z');
    const GRACE_PERIOD = 7; // 7 days grace

    it('Test 7: Exact grace-period boundary is NOT overdue (strictly after required)', () => {
      // Exactly at DUE_DATE + 7 days
      const exactCutoff = new Date(DUE_DATE.getTime() + GRACE_PERIOD * MS_PER_DAY);
      const isOverdue = isServiceOverdue({
        status: 'DUE',
        dueDate: DUE_DATE,
        gracePeriodDays: GRACE_PERIOD,
        evaluationTime: exactCutoff,
      });

      assert.equal(isOverdue, false);
    });

    it('Test 8: One millisecond / moment after grace period IS overdue', () => {
      // 1 ms after DUE_DATE + 7 days
      const pastCutoff = new Date(DUE_DATE.getTime() + GRACE_PERIOD * MS_PER_DAY + 1);
      const isOverdue = isServiceOverdue({
        status: 'DUE',
        dueDate: DUE_DATE,
        gracePeriodDays: GRACE_PERIOD,
        evaluationTime: pastCutoff,
      });

      assert.equal(isOverdue, true);
    });

    it('Test 8b: Evaluates overdue for BOOKED status as well', () => {
      const pastCutoff = new Date(DUE_DATE.getTime() + (GRACE_PERIOD + 2) * MS_PER_DAY);
      const isOverdue = isServiceOverdue({
        status: 'BOOKED',
        dueDate: DUE_DATE,
        gracePeriodDays: GRACE_PERIOD,
        evaluationTime: pastCutoff,
      });

      assert.equal(isOverdue, true);
    });

    it('Test 9: Future due date is NEVER overdue', () => {
      const now = new Date('2026-02-01T00:00:00.000Z');
      const futureDueDate = new Date('2026-03-01T00:00:00.000Z'); // 1 month in future

      const isOverdue = isServiceOverdue({
        status: 'DUE',
        dueDate: futureDueDate,
        gracePeriodDays: GRACE_PERIOD,
        evaluationTime: now,
      });

      assert.equal(isOverdue, false);
    });

    it('Lifecycle states IN_SERVICE and COMPLETED are NEVER overdue', () => {
      // Way past cutoff (100 days past dueDate)
      const farFuture = new Date(DUE_DATE.getTime() + 100 * MS_PER_DAY);

      const inServiceOverdue = isServiceOverdue({
        status: 'IN_SERVICE',
        dueDate: DUE_DATE,
        gracePeriodDays: GRACE_PERIOD,
        evaluationTime: farFuture,
      });
      assert.equal(inServiceOverdue, false);

      const completedOverdue = isServiceOverdue({
        status: 'COMPLETED',
        dueDate: DUE_DATE,
        gracePeriodDays: GRACE_PERIOD,
        evaluationTime: farFuture,
      });
      assert.equal(completedOverdue, false);
    });

    it('Missing dueDate is not overdue', () => {
      const isOverdue = isServiceOverdue({
        status: 'DUE',
        dueDate: null,
        gracePeriodDays: GRACE_PERIOD,
      });
      assert.equal(isOverdue, false);
    });

    it('Rejects negative grace period values', () => {
      assert.throws(
        () =>
          isServiceOverdue({
            status: 'DUE',
            dueDate: DUE_DATE,
            gracePeriodDays: -1,
          }),
        /Invalid gracePeriodDays/
      );
    });
  });
});
