/**
 * Default trigger registry + built-in registration.
 *
 * The registry is a process-level singleton by default (sufficient for the
 * canonical single-engine-per-process deployment). Tests and multi-engine
 * hosts can construct their own `TriggerRegistry` instances and pass them
 * through explicitly.
 */
import { TriggerRegistry } from './registry';
import { TimerTrigger } from './timer/timer-trigger';
import { GraphMailboxTrigger } from './graph-mailbox/graph-mailbox-trigger';
import { SharePointFolderTrigger } from './sharepoint-folder/sharepoint-folder-trigger';
import { AIListenerTrigger } from './ai-listener/ai-listener-trigger';
import type { StartTrigger } from './types';

export { TriggerRegistry } from './registry';
export * from './types';
export { stripTriPrefix } from './attrs';
export { GraphMailboxTrigger } from './graph-mailbox/graph-mailbox-trigger';
export { TimerTrigger } from './timer/timer-trigger';
export { SharePointFolderTrigger } from './sharepoint-folder/sharepoint-folder-trigger';
export { AIListenerTrigger } from './ai-listener/ai-listener-trigger';

/** Populate a registry with the engine's built-in triggers. */
export function registerBuiltInTriggers(registry: TriggerRegistry): void {
  registry.register(new TimerTrigger());
  registry.register(new GraphMailboxTrigger());
  registry.register(new SharePointFolderTrigger());
  registry.register(new AIListenerTrigger());
}

/** Lazily-initialized default registry used when callers don't pass one explicitly. */
let defaultRegistryInstance: TriggerRegistry | null = null;

export function getDefaultTriggerRegistry(): TriggerRegistry {
  if (defaultRegistryInstance === null) {
    defaultRegistryInstance = new TriggerRegistry();
    registerBuiltInTriggers(defaultRegistryInstance);
  }
  return defaultRegistryInstance;
}

/**
 * Reset the default registry — primarily for tests that want a clean slate.
 * Production code should never need this.
 */
export function resetDefaultTriggerRegistry(): void {
  defaultRegistryInstance = null;
}

export function listBuiltInTriggers(): StartTrigger[] {
  return getDefaultTriggerRegistry().list();
}
