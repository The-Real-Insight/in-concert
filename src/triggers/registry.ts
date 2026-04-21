/**
 * Trigger registry. Engine-instance-scoped (not a global singleton) so
 * consumers can run multiple engines in the same process with different
 * trigger sets — useful for tests and multi-tenant hosts.
 */

import type { StartTrigger } from './types';

export class TriggerRegistry {
  private readonly triggers = new Map<string, StartTrigger>();

  /**
   * Register a trigger implementation. Throws if `triggerType` is already
   * registered — duplicate registration is always a bug.
   */
  register(trigger: StartTrigger): void {
    if (this.triggers.has(trigger.triggerType)) {
      throw new Error(
        `Trigger "${trigger.triggerType}" is already registered. ` +
          `Duplicate registration is not allowed.`,
      );
    }
    this.triggers.set(trigger.triggerType, trigger);
  }

  get(triggerType: string): StartTrigger | undefined {
    return this.triggers.get(triggerType);
  }

  list(): StartTrigger[] {
    return Array.from(this.triggers.values());
  }

  has(triggerType: string): boolean {
    return this.triggers.has(triggerType);
  }
}
