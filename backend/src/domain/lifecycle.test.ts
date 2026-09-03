import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTransition,
  assertValidTransition,
  assertTransitionAuthorized,
  InvalidTransitionError,
  ForbiddenActionError,
  ValidationError,
} from './lifecycle';

describe('Service Lifecycle State Machine & Authorization Rules', () => {
  describe('State Machine Transitions', () => {
    it('DUE -> BOOKED succeeds', () => {
      assert.equal(isValidTransition('DUE', 'BOOKED'), true);
      assert.doesNotThrow(() => assertValidTransition('DUE', 'BOOKED'));
    });

    it('BOOKED -> IN_SERVICE succeeds', () => {
      assert.equal(isValidTransition('BOOKED', 'IN_SERVICE'), true);
      assert.doesNotThrow(() => assertValidTransition('BOOKED', 'IN_SERVICE'));
    });

    it('IN_SERVICE -> COMPLETED succeeds', () => {
      assert.equal(isValidTransition('IN_SERVICE', 'COMPLETED'), true);
      assert.doesNotThrow(() => assertValidTransition('IN_SERVICE', 'COMPLETED'));
    });

    it('Same status transitions succeed (no-op)', () => {
      assert.equal(isValidTransition('DUE', 'DUE'), true);
      assert.equal(isValidTransition('BOOKED', 'BOOKED'), true);
      assert.equal(isValidTransition('IN_SERVICE', 'IN_SERVICE'), true);
      assert.equal(isValidTransition('COMPLETED', 'COMPLETED'), true);
    });

    it('DUE -> COMPLETED fails (skipping states)', () => {
      assert.equal(isValidTransition('DUE', 'COMPLETED'), false);
      assert.throws(() => assertValidTransition('DUE', 'COMPLETED'), InvalidTransitionError);
    });

    it('DUE -> IN_SERVICE fails (skipping booking)', () => {
      assert.equal(isValidTransition('DUE', 'IN_SERVICE'), false);
      assert.throws(() => assertValidTransition('DUE', 'IN_SERVICE'), InvalidTransitionError);
    });

    it('BOOKED -> COMPLETED fails (skipping in-service)', () => {
      assert.equal(isValidTransition('BOOKED', 'COMPLETED'), false);
      assert.throws(() => assertValidTransition('BOOKED', 'COMPLETED'), InvalidTransitionError);
    });

    it('COMPLETED -> DUE fails (terminal state backwards)', () => {
      assert.equal(isValidTransition('COMPLETED', 'DUE'), false);
      assert.throws(() => assertValidTransition('COMPLETED', 'DUE'), InvalidTransitionError);
    });

    it('COMPLETED -> BOOKED fails (terminal state backwards)', () => {
      assert.equal(isValidTransition('COMPLETED', 'BOOKED'), false);
      assert.throws(() => assertValidTransition('COMPLETED', 'BOOKED'), InvalidTransitionError);
    });

    it('IN_SERVICE -> BOOKED fails (backwards transition)', () => {
      assert.equal(isValidTransition('IN_SERVICE', 'BOOKED'), false);
      assert.throws(() => assertValidTransition('IN_SERVICE', 'BOOKED'), InvalidTransitionError);
    });
  });

  describe('Authorization Rules', () => {
    const managerAuth = {
      userRole: 'FLEET_MANAGER' as const,
      userId: 'manager-1',
      assignedUserIds: ['tech-1'],
    };

    const assignedTechAuth = {
      userRole: 'TECHNICIAN' as const,
      userId: 'tech-1',
      assignedUserIds: ['tech-1'],
    };

    const unassignedTechAuth = {
      userRole: 'TECHNICIAN' as const,
      userId: 'tech-2',
      assignedUserIds: ['tech-1'],
    };

    it('Technician cannot book DUE service', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized('DUE', 'BOOKED', assignedTechAuth, {
            dateScheduled: new Date(),
          }),
        ForbiddenActionError
      );
    });

    it('Manager can book DUE service with dateScheduled and assigned technician', () => {
      assert.doesNotThrow(() =>
        assertTransitionAuthorized('DUE', 'BOOKED', managerAuth, {
          dateScheduled: new Date('2026-10-01'),
        })
      );
    });

    it('Manager booking fails if dateScheduled is missing', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized('DUE', 'BOOKED', managerAuth, {
            dateScheduled: null,
          }),
        ValidationError
      );
    });

    it('Manager booking fails if no technician is assigned', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized(
            'DUE',
            'BOOKED',
            { ...managerAuth, assignedUserIds: [] },
            { dateScheduled: new Date('2026-10-01') }
          ),
        ValidationError
      );
    });

    it('Assigned Technician can start BOOKED service', () => {
      assert.doesNotThrow(() =>
        assertTransitionAuthorized('BOOKED', 'IN_SERVICE', assignedTechAuth)
      );
    });

    it('Manager can start BOOKED service', () => {
      assert.doesNotThrow(() =>
        assertTransitionAuthorized('BOOKED', 'IN_SERVICE', managerAuth)
      );
    });

    it('Unassigned Technician cannot start BOOKED service (receives 403 Forbidden)', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized('BOOKED', 'IN_SERVICE', unassignedTechAuth),
        ForbiddenActionError
      );
    });

    it('Assigned Technician can complete IN_SERVICE service with valid odometer', () => {
      assert.doesNotThrow(() =>
        assertTransitionAuthorized('IN_SERVICE', 'COMPLETED', assignedTechAuth, {
          completedOdometer: 52_000,
          vehicleOdometer: 50_000,
        })
      );
    });

    it('Manager can complete IN_SERVICE service with valid odometer', () => {
      assert.doesNotThrow(() =>
        assertTransitionAuthorized('IN_SERVICE', 'COMPLETED', managerAuth, {
          completedOdometer: 50_000,
          vehicleOdometer: 50_000,
        })
      );
    });

    it('Unassigned Technician cannot complete IN_SERVICE service (receives 403 Forbidden)', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized('IN_SERVICE', 'COMPLETED', unassignedTechAuth, {
            completedOdometer: 55_000,
            vehicleOdometer: 50_000,
          }),
        ForbiddenActionError
      );
    });

    it('Completion rejects lower completedOdometer', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized('IN_SERVICE', 'COMPLETED', assignedTechAuth, {
            completedOdometer: 48_000, // Less than current 50,000
            vehicleOdometer: 50_000,
          }),
        ValidationError
      );
    });

    it('Completion rejects missing completedOdometer', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized('IN_SERVICE', 'COMPLETED', assignedTechAuth, {
            completedOdometer: null,
            vehicleOdometer: 50_000,
          }),
        ValidationError
      );
    });

    it('Technician cannot update notes on unassigned service', () => {
      assert.throws(
        () =>
          assertTransitionAuthorized('IN_SERVICE', 'IN_SERVICE', unassignedTechAuth),
        ForbiddenActionError
      );
    });

    it('Technician can update notes on assigned service', () => {
      assert.doesNotThrow(() =>
        assertTransitionAuthorized('IN_SERVICE', 'IN_SERVICE', assignedTechAuth)
      );
    });
  });
});
