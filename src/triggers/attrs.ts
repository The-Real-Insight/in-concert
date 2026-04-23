/**
 * Small helpers that plugins use to turn a raw extension-attribute bag from
 * {@link BpmnStartEventView} into the shape they want to store on the
 * TriggerSchedule row. The engine doesn't call these — they're a convenience
 * for plugin authors. TRI's own bundled plugins use `stripTriPrefix`; plugins
 * that choose a different namespace prefix use the generic {@link stripPrefix}.
 */

/**
 * Strip a namespace prefix from attribute keys, optionally removing a set of
 * keys entirely (e.g. the discriminator attribute that the engine already
 * knows via the trigger's own `triggerType`). Works for any prefix; use this
 * when your plugin reads attributes under a namespace other than `tri:`.
 *
 *   stripPrefix({ 'acme:foo': 'x', 'acme:connectorType': 'my-trigger' }, 'acme:', ['connectorType'])
 *   // => { foo: 'x' }
 *
 * The `prefix` must include the trailing `:`. The `omit` list may be
 * supplied with or without the prefix — both forms normalise to the same
 * short key.
 */
export function stripPrefix(
  attrs: Record<string, string>,
  prefix: string,
  omit: string[] = [],
): Record<string, string> {
  const omitSet = new Set(
    omit.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k)),
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith(prefix)) continue;
    const short = k.slice(prefix.length);
    if (omitSet.has(short)) continue;
    out[short] = v;
  }
  return out;
}

/**
 * Convenience wrapper over {@link stripPrefix} for the `tri:` namespace.
 * Used by the bundled built-in triggers; thin alias for host convenience.
 *
 *   stripTriPrefix({ 'tri:foo': 'x', 'tri:connectorType': 'my-trigger' }, ['connectorType'])
 *   // => { foo: 'x' }
 */
export function stripTriPrefix(
  attrs: Record<string, string>,
  omit: string[] = [],
): Record<string, string> {
  return stripPrefix(attrs, 'tri:', omit);
}
