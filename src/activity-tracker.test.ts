/**
 * Tests for activity-tracker module.
 *
 * Covers:
 * - recordActivity() updates the timestamp
 * - getLastActivityTs() returns the current value
 * - isInactive() with default and custom thresholds
 * - Edge cases: no activity recorded, exact threshold boundary
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordActivity,
  getLastActivityTs,
  isInactive,
  _resetForTesting,
} from "./activity-tracker.js";

describe("activity-tracker", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("recordActivity()", () => {
    it("updates the last activity timestamp to Date.now()", () => {
      vi.setSystemTime(new Date("2026-03-05T12:00:00Z"));
      expect(getLastActivityTs()).toBe(0);

      recordActivity();

      expect(getLastActivityTs()).toBe(new Date("2026-03-05T12:00:00Z").getTime());
    });

    it("updates on each call", () => {
      vi.setSystemTime(new Date("2026-03-05T12:00:00Z"));
      recordActivity();
      const first = getLastActivityTs();

      vi.setSystemTime(new Date("2026-03-05T12:05:00Z"));
      recordActivity();
      const second = getLastActivityTs();

      expect(second).toBeGreaterThan(first);
      expect(second - first).toBe(5 * 60 * 1000);
    });
  });

  describe("getLastActivityTs()", () => {
    it("returns 0 when no activity has been recorded", () => {
      expect(getLastActivityTs()).toBe(0);
    });

    it("returns the most recent timestamp after recordActivity()", () => {
      vi.setSystemTime(1000000);
      recordActivity();
      expect(getLastActivityTs()).toBe(1000000);
    });
  });

  describe("isInactive()", () => {
    it("returns true when no activity has ever been recorded", () => {
      expect(isInactive()).toBe(true);
    });

    it("returns false immediately after recordActivity()", () => {
      recordActivity();
      expect(isInactive()).toBe(false);
    });

    it("returns true after default threshold (15 minutes) has elapsed", () => {
      recordActivity();
      expect(isInactive()).toBe(false);

      // Advance 15 minutes
      vi.advanceTimersByTime(15 * 60 * 1000);
      expect(isInactive()).toBe(true);
    });

    it("returns false just before the threshold", () => {
      recordActivity();

      // Advance 14 minutes 59 seconds
      vi.advanceTimersByTime(15 * 60 * 1000 - 1000);
      expect(isInactive()).toBe(false);
    });

    it("accepts a custom threshold", () => {
      recordActivity();

      // Custom threshold: 5 minutes
      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(isInactive(5 * 60 * 1000)).toBe(false);

      vi.advanceTimersByTime(1 * 60 * 1000);
      expect(isInactive(5 * 60 * 1000)).toBe(true);
    });

    it("works with very short thresholds", () => {
      recordActivity();

      vi.advanceTimersByTime(99);
      expect(isInactive(100)).toBe(false);

      vi.advanceTimersByTime(1);
      expect(isInactive(100)).toBe(true);
    });

    it("resets correctly via _resetForTesting()", () => {
      recordActivity();
      expect(isInactive()).toBe(false);

      _resetForTesting();
      expect(getLastActivityTs()).toBe(0);
      expect(isInactive()).toBe(true);
    });
  });
});
