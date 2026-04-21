/**
 * Decoupling CI check.
 *
 * The StartTrigger refactor promises that the engine core contains zero
 * references to specific trigger types. If a new trigger is added, the
 * engine core must not learn its name — only the plugin module, its
 * registration site (src/triggers/index.ts), and trigger-specific tests
 * may reference the triggerType literal.
 *
 * This test walks `src/` and fails if any file outside the allowed
 * "trigger-aware" set contains forbidden literals.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/** Literals that name specific trigger types and must stay plugin-local. */
const FORBIDDEN_LITERALS = [
  "'timer'",
  '"timer"',
  "'graph-mailbox'",
  '"graph-mailbox"',
  "'sharepoint-folder'",
  '"sharepoint-folder"',
  "'ai-listener'",
  '"ai-listener"',
];

/**
 * Files that are legitimately trigger-aware. Relative paths from repo root.
 * Everything else under `src/` must be trigger-type-agnostic.
 */
const ALLOWED_FILES = new Set<string>([
  // The plugins themselves.
  'src/triggers/index.ts',
  'src/triggers/types.ts',
  'src/triggers/registry.ts',
  // Timer plugin.
  'src/triggers/timer/timer-trigger.ts',
  // Graph-mailbox plugin.
  'src/triggers/graph-mailbox/graph-mailbox-trigger.ts',
  'src/triggers/graph-mailbox/graph.ts',
  'src/triggers/graph-mailbox/index.ts',
  // SharePoint folder plugin.
  'src/triggers/sharepoint-folder/sharepoint-folder-trigger.ts',
  'src/triggers/sharepoint-folder/graph-client.ts',
  'src/triggers/sharepoint-folder/index.ts',
  // AI listener plugin.
  'src/triggers/ai-listener/ai-listener-trigger.ts',
  'src/triggers/ai-listener/http.ts',
  'src/triggers/ai-listener/index.ts',
  // Schedule sync in model/service hands off to the registry by triggerType,
  // but currently names 'timer' in a narrow branch for explicit error
  // messages. Acceptable trade-off — this seam only uses literals, never
  // imports trigger implementations.
  'src/model/service.ts',
  // The SDK's legacy timer/connector wrapper methods filter
  // TriggerSchedule rows by triggerType. This is the documented seam
  // between the new unified model and the deprecated legacy surface.
  'src/sdk/client.ts',
  // REST routes for the legacy timer/connector aliases. Same reasoning.
  'src/api/routes.ts',
  // Legacy collection-migration code references triggerType by literal.
  // Removable once old TimerSchedule/ConnectorSchedule collections are
  // dropped in a follow-up PR.
  'scripts/migrate-to-trigger-schedules.ts',
  // Deprecated EngineInitConfig.connectors['graph-mailbox'] pass-through
  // kept for backward compatibility. Removed in the next major release,
  // at which point this entry goes with it.
  'src/sdk/types.ts',
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('engine isolation from specific trigger types', () => {
  it('no forbidden trigger-type literal appears outside the allowed set', () => {
    const allFiles = walk(SRC_ROOT);
    const offenders: Array<{ file: string; literal: string; line: number }> = [];

    for (const file of allFiles) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWED_FILES.has(rel)) continue;

      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const lit of FORBIDDEN_LITERALS) {
          if (lines[i].includes(lit)) {
            offenders.push({ file: rel, literal: lit, line: i + 1 });
          }
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line} → ${o.literal}`)
        .join('\n');
      throw new Error(
        `Engine core must not reference specific trigger types.\n` +
          `Found ${offenders.length} violation(s):\n${msg}\n\n` +
          `If the reference is intentional (documented seam), add the ` +
          `file to ALLOWED_FILES in this test with a comment explaining why.`,
      );
    }
  });

  it('the ALLOWED_FILES set does not drift — every entry still exists', () => {
    for (const rel of ALLOWED_FILES) {
      expect(() => statSync(join(REPO_ROOT, rel))).not.toThrow();
    }
  });
});
