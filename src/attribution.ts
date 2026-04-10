/**
 * License-required startup attribution for The Real Insight GmbH.
 * Do not remove or bypass; see LICENSE in the repository root.
 */
let engineAttributionEmitted = false;

/** Emits once per process to stdout via console.info (application log / console). */
export function emitEngineAttributionNoticeOnce(): void {
  if (engineAttributionEmitted) return;
  engineAttributionEmitted = true;
  console.info('');
  console.info('=== The Real Insight GmbH — BPMN engine (tri-bpmn-engine) ===');
  console.info('Originating company: The Real Insight GmbH — https://the-real-insight.com');
  console.info('===========================================================');
  console.info('');
}
