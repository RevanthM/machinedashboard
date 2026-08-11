/**
 * Wire format for collector output.
 *
 * Collectors emit tab-separated `key<TAB>value` lines rather than JSON. Three
 * reasons, all learned from the shells involved:
 *
 *   - PowerShell's ConvertTo-Json quotes and escapes differently across 5.1 and
 *     7.x, and wraps single-element arrays inconsistently;
 *   - constructing valid JSON in POSIX sh without jq (not installed on a stock
 *     macOS) means hand-escaping, which is the class of bug the shell module
 *     exists to eliminate;
 *   - a tab never appears in the values we collect, so parsing is total.
 *
 * Nested data uses dotted keys with a numeric index: `gpu.0.model`.
 */

export type Flat = Map<string, string>;

export function parseFlat(stdout: string): Flat {
  const out: Flat = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab).trim();
    const value = line.slice(tab + 1).trim();
    if (key) out.set(key, value);
  }
  return out;
}

export function num(flat: Flat, key: string): number | undefined {
  const raw = flat.get(key);
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw.replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function str(flat: Flat, key: string): string | undefined {
  const raw = flat.get(key)?.trim();
  return raw ? raw : undefined;
}

/**
 * Collect indexed groups: `gpu.0.model`, `gpu.1.model` -> [{model}, {model}].
 * Stops at the first missing index so a gap cannot produce phantom entries.
 */
export function group(flat: Flat, prefix: string): Array<Map<string, string>> {
  const out: Array<Map<string, string>> = [];
  for (let i = 0; ; i++) {
    const entryPrefix = `${prefix}.${i}.`;
    const entry = new Map<string, string>();
    for (const [key, value] of flat) {
      if (key.startsWith(entryPrefix)) entry.set(key.slice(entryPrefix.length), value);
    }
    if (entry.size === 0) break;
    out.push(entry);
  }
  return out;
}
