/**
 * Ownership abstraction for the continuation worker.
 *
 * Single-server mode: NoOp implementation — every instance is "owned" by this
 * process. No coordination needed, no exclusion list.
 *
 * Multi-server mode (future Layer 2): a DB-backed implementation writes a
 * lease row per instance with a `claimedBy: serverId, expiresAt: ...` pair,
 * renewed via heartbeat. Other servers skip instances leased by a live owner;
 * a sweeper reaps expired leases so instances whose owner died get picked up.
 *
 * The EngineWorker calls `shouldProcess` before spawning an instance-worker,
 * `onClaim` just before spawning, and `onRelease` when the instance-worker
 * exits. Swapping implementations is the sole change required to go
 * multi-server; the worker body is implementation-agnostic.
 */

/**
 * Result of calling `shouldProcess`. Either "yes, run it" (the caller should
 * spawn an instance-worker), or "no, someone else owns it" (skip).
 */
export type OwnershipDecision = 'process' | 'skip';

export interface InstanceOwnership {
  /**
   * Called before a candidate instance is routed to a worker. Return
   * 'process' to accept ownership (engine will call `onClaim` then spawn the
   * worker), 'skip' to leave it for another server.
   *
   * Single-server: always 'process'.
   */
  shouldProcess(instanceId: string): Promise<OwnershipDecision>;

  /**
   * Called after `shouldProcess` returned 'process' and before the
   * instance-worker starts. Multi-server impls persist the claim here.
   */
  onClaim(instanceId: string): Promise<void>;

  /**
   * Called when the instance-worker exits (instance quiescent, terminal, or
   * errored). Multi-server impls release the claim here.
   */
  onRelease(instanceId: string): Promise<void>;
}

/**
 * Single-server implementation: no coordination. Every candidate is processed
 * by this server; claim/release are no-ops. Safe to use as the default; swap
 * in a DB-backed implementation when scaling to multiple servers.
 */
export class SingleServerOwnership implements InstanceOwnership {
  async shouldProcess(_instanceId: string): Promise<OwnershipDecision> {
    return 'process';
  }

  async onClaim(_instanceId: string): Promise<void> {
    /* no-op */
  }

  async onRelease(_instanceId: string): Promise<void> {
    /* no-op */
  }
}
