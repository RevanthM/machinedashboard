/**
 * Redaction for anything persisted or streamed (N-03).
 *
 * Provisioning stdout is written to `provision_runs` and pushed live to the
 * browser. Installers echo their arguments, `set -x` leaks environment, and a
 * failing command often prints the command line that failed — so output has to
 * be scrubbed on the way out, not merely kept out of the input.
 *
 * Two layers, because either alone is insufficient:
 *   1. exact values we know are secret (vault contents, setup keys);
 *   2. shape-based patterns, for secrets we were never told about.
 */

const MIN_LITERAL_LENGTH = 6;

export interface ScrubberOptions {
  /** Exact strings to redact — vault values, setup keys, PATs. */
  literals?: readonly string[];
}

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // PEM bodies. Matched before anything else; a leaked key is unrecoverable.
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    label: 'PRIVATE KEY',
  },
  // NetBird setup keys and similar UUID-shaped credentials on a flag.
  {
    re: /(--setup-key[= ]+)(\S+)/gi,
    label: 'SETUP KEY',
  },
  {
    re: /(Authorization:\s*(?:Token|Bearer)\s+)(\S+)/gi,
    label: 'TOKEN',
  },
  // Generic key=value where the key name implies a secret.
  {
    re: /((?:password|passwd|passphrase|secret|token|api[_-]?key|pat)\s*[=:]\s*)(\S+)/gi,
    label: 'REDACTED',
  },
  // `sudo -S` prompts and echoed stdin.
  {
    re: /(\[sudo\] password for [^:]+:\s*)(\S+)/gi,
    label: 'REDACTED',
  },
];

export class Scrubber {
  private literals: string[];

  constructor(opts: ScrubberOptions = {}) {
    this.literals = dedupeSorted(opts.literals ?? []);
  }

  /** Refresh the known-secret list, e.g. after an import adds vault entries. */
  setLiterals(literals: readonly string[]): void {
    this.literals = dedupeSorted(literals);
  }

  scrub(text: string): string {
    if (!text) return text;
    let out = text;

    // Literals first: a known password that also matches a pattern should be
    // replaced by the specific marker, not the generic one.
    for (const literal of this.literals) {
      out = out.split(literal).join('«redacted»');
    }

    for (const { re, label } of PATTERNS) {
      out = out.replace(re, (match, prefix?: string) =>
        prefix === undefined ? `«${label} redacted»` : `${prefix}«${label} redacted»`,
      );
    }

    return out;
  }
}

/**
 * Longest-first so that a secret which is a substring of another is not
 * partially replaced, leaving a recognisable remainder. Values shorter than
 * MIN_LITERAL_LENGTH are dropped — redacting every occurrence of a 3-character
 * password would corrupt unrelated output without meaningfully protecting it.
 */
function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v && v.length >= MIN_LITERAL_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
}
