/**
 * Shared transmitter mock for all test files.
 *
 * Bun runs all test files in the same process, so only ONE vi.mock factory
 * for a given module path "wins". By having all test files use the same
 * shared mock object, it doesn't matter which factory wins — they all
 * reference the same vi.fn() instances and enqueuedEvents array.
 */
import { vi } from "vitest";

/** Shared array that collects all enqueued events across tests */
export const enqueuedEvents: any[] = [];

/** The canonical transmitter mock object — used by ALL test files */
export const mockTransmitter = {
  start: vi.fn(),
  enqueue: vi.fn((event: any) => enqueuedEvents.push(event)),
  bufferedCount: 0,
  getAgentUptimeHours: vi.fn().mockReturnValue(0.1),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getCachedBudget: vi.fn().mockReturnValue(null),
  markCredentialAccess: vi.fn(),
  hasRecentCredentialAccess: vi.fn().mockReturnValue(false),
  getRecentCredentialAccess: vi.fn().mockReturnValue(null),
  isKnownTool: vi.fn().mockReturnValue(false),
  recordToolSeen: vi.fn(),
  updateBudgetFromResponse: vi.fn(),
  _enqueuedEvents: enqueuedEvents,
  _reset() {
    enqueuedEvents.length = 0;
  },
};

/**
 * Reset all mock functions and the enqueued events array.
 * Call this in beforeEach to get a clean state.
 */
export function resetMockTransmitter(): void {
  enqueuedEvents.length = 0;
  mockTransmitter.start.mockReset();
  mockTransmitter.enqueue.mockReset().mockImplementation((event: any) => enqueuedEvents.push(event));
  mockTransmitter.getAgentUptimeHours.mockReset().mockReturnValue(0.1);
  mockTransmitter.shutdown.mockReset().mockResolvedValue(undefined);
  mockTransmitter.getCachedBudget.mockReset().mockReturnValue(null);
  mockTransmitter.markCredentialAccess.mockReset();
  mockTransmitter.hasRecentCredentialAccess.mockReset().mockReturnValue(false);
  mockTransmitter.getRecentCredentialAccess.mockReset().mockReturnValue(null);
  mockTransmitter.isKnownTool.mockReset().mockReturnValue(false);
  mockTransmitter.recordToolSeen.mockReset();
  mockTransmitter.updateBudgetFromResponse.mockReset();
  mockTransmitter.bufferedCount = 0;
}
