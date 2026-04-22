/**
 * Small helpers that plugins use to turn a raw `tri:*` attribute bag from
 * {@link BpmnStartEventView} into the shape they want to store on the
 * TriggerSchedule row. The engine doesn't call these — they're a convenience
 * for plugin authors.
 */

/**
 * Strip the `tri:` prefix from attribute keys, optionally removing a set of
 * keys entirely (e.g. the discriminator `connectorType` that the engine
 * already knows via the trigger's own `triggerType`).
 *
 *   stripTriPrefix({ 'tri:foo': 'x', 'tri:connectorType': 'my-trigger' }, ['connectorType'])
 *   // => { foo: 'x' }
 */
export function stripTriPrefix(
  attrs: Record<string, string>,
  omit: string[] = [],
): Record<string, string> {
  const omitSet = new Set(omit.map((k) => (k.startsWith('tri:') ? k.slice(4) : k)));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const short = k.startsWith('tri:') ? k.slice(4) : k;
    if (omitSet.has(short)) continue;
    out[short] = v;
  }
  return out;
}
