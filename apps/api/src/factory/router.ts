/**
 * Resolve which host(s) a factory chat message is talking about.
 */
import { displayName } from '../hosts/display.js';
import type { Host } from '../db/schema.js';

export interface HostResolution {
  hosts: Host[];
  /** Text with host-addressing phrases removed, for the per-host agent. */
  taskText: string;
  mode: 'single' | 'multi' | 'none';
  reason: string;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return norm(s).split(/\s+/).filter(Boolean);
}

/** Score how well a phrase matches a host. */
function scoreHost(host: Host, hay: string): number {
  const nHay = norm(hay);
  const candidates = [host.nickname, host.name, host.hostname]
    .filter(Boolean)
    .map((s) => norm(String(s)));

  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (nHay.includes(c) || c.includes(nHay)) best = Math.max(best, 100 + c.length);
    const ct = c.split(/\s+/);
    const overlap = ct.filter((t) => t.length > 2 && nHay.includes(t)).length;
    if (overlap > 0) best = Math.max(best, overlap * 20 + (overlap === ct.length ? 30 : 0));
  }
  for (const tag of host.tags ?? []) {
    const t = norm(tag);
    if (t && nHay.includes(t)) best = Math.max(best, 40);
  }
  return best;
}

const MULTI_PATTERNS: Array<{ re: RegExp; pick: (hosts: Host[]) => Host[] }> = [
  {
    re: /\b(all hosts|every (host|machine|computer)|fleet[- ]?wide)\b/i,
    pick: (hosts) => hosts.filter((h) => h.status === 'online' || h.isSelf),
  },
  {
    re: /\b(all (online )?macs?|every mac)\b/i,
    pick: (hosts) => hosts.filter((h) => h.os === 'macos'),
  },
  {
    re: /\b(all (online )?windows|every windows)\b/i,
    pick: (hosts) => hosts.filter((h) => h.os === 'windows'),
  },
  {
    re: /\b(all (online )?linux|every (linux|ubuntu))\b/i,
    pick: (hosts) => hosts.filter((h) => h.os === 'ubuntu' || h.os === 'debian'),
  },
];

const STRIP_PHRASES = [
  /\bon (the )?/gi,
  /\busing (the )?/gi,
  /\bvia (the )?/gi,
  /\bfor (the )?/gi,
];

/**
 * Strip host-addressing from the operator text so the per-host agent gets a clean task.
 */
export function stripHostAddressing(text: string, matched: Host[]): string {
  let out = text;
  for (const h of matched) {
    for (const label of [h.nickname, h.name, h.hostname].filter(Boolean)) {
      const re = new RegExp(
        `\\b(on|using|via|for|at)?\\s*(the\\s+)?${escapeRe(String(label))}\\b`,
        'gi',
      );
      out = out.replace(re, ' ');
    }
  }
  out = out.replace(/\bon (my|the) (mac|pc|computer|machine|host)\b/gi, ' ');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out || text.trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveHostsFromText(text: string, inventory: Host[]): HostResolution {
  const trimmed = text.trim();
  if (!trimmed) {
    return { hosts: [], taskText: '', mode: 'none', reason: 'Empty message.' };
  }

  for (const pat of MULTI_PATTERNS) {
    if (pat.re.test(trimmed)) {
      const hosts = pat.pick(inventory);
      return {
        hosts,
        taskText: stripHostAddressing(trimmed, hosts),
        mode: hosts.length > 1 ? 'multi' : hosts.length === 1 ? 'single' : 'none',
        reason:
          hosts.length === 0
            ? 'No hosts matched that fleet filter.'
            : `Targeting ${hosts.length} host(s) from fleet filter.`,
      };
    }
  }

  const scored = inventory
    .map((h) => ({ h, score: scoreHost(h, trimmed) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      hosts: [],
      taskText: trimmed,
      mode: 'none',
      reason:
        'Could not tell which computer you mean. Try a nickname or say e.g. "on the Mac mini". ' +
        `Known: ${inventory.map((h) => displayName(h)).join(', ')}`,
    };
  }

  const top = scored[0]!;
  // If two hosts score closely, ask — unless one clearly wins.
  const contenders = scored.filter((s) => s.score >= top.score * 0.85 && s.score >= 40);
  if (contenders.length > 1 && top.score < 100) {
    return {
      hosts: [],
      taskText: trimmed,
      mode: 'none',
      reason:
        `Ambiguous host — did you mean ${contenders.map((c) => displayName(c.h)).join(' or ')}?`,
    };
  }

  // Also catch "mac mini" and "macbook" both matching loosely — require minimum score.
  if (top.score < 25) {
    return {
      hosts: [],
      taskText: trimmed,
      mode: 'none',
      reason:
        'Host mention too vague. ' +
        `Known: ${inventory.map((h) => displayName(h)).join(', ')}`,
    };
  }

  const hosts = [top.h];
  return {
    hosts,
    taskText: stripHostAddressing(trimmed, hosts),
    mode: 'single',
    reason: `Resolved to ${displayName(top.h)}.`,
  };
}

export { tokens, STRIP_PHRASES };
