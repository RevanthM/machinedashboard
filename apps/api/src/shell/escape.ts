/**
 * Per-OS command construction.
 *
 * PRD §14 lists "Windows OpenSSH + PowerShell quoting hell" as a named risk and
 * mandates: base64-encode PowerShell payloads, never hand-quote. This module is
 * the only place in the codebase allowed to build a command line. Everything
 * else calls `wrapScript`.
 *
 * The core idea: don't escape at all where we can avoid it. Both wrappers
 * transport the script as base64 and let the remote shell decode it, so the
 * script body never passes through a quoting layer. That makes payloads with
 * quotes, newlines, backticks, `$`, unicode, and NUL-adjacent bytes safe by
 * construction rather than by a regex we have to keep getting right.
 */

export type OsFamily = 'ubuntu' | 'debian' | 'windows' | 'macos';

export const POSIX_FAMILIES: readonly OsFamily[] = ['ubuntu', 'debian', 'macos'];

export function isPosix(os: OsFamily): boolean {
  return POSIX_FAMILIES.includes(os);
}

/**
 * Quote a single value for use as one argument in a shell command line.
 *
 * Prefer `wrapScript` for anything non-trivial. This exists for the narrow case
 * of interpolating a value into a command template we control.
 */
export function quoteArg(value: string, os: OsFamily): string {
  return os === 'windows' ? quoteArgPowerShell(value) : quoteArgPosix(value);
}

/**
 * POSIX: wrap in single quotes and close/escape/reopen around embedded quotes.
 * Inside single quotes every character is literal, so this is total — there is
 * no escape sequence a caller can smuggle through.
 */
function quoteArgPosix(value: string): string {
  if (value === '') return "''";
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * PowerShell: single-quoted literal, where the only escape is a doubled quote.
 * Note this is the PowerShell *parser's* rule, distinct from cmd.exe's, which
 * we never target — the provisioner sets PowerShell as the SSH default shell.
 */
function quoteArgPowerShell(value: string): string {
  if (value === '') return "''";
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Forces PowerShell to write stdout/stderr as UTF-8.
 *
 * Without this, PowerShell encodes output using the console's active code page
 * (Windows-1252 on a default US install). Accented characters come back as
 * mojibake and anything outside the code page — CJK, emoji — is replaced with
 * literal `?` before it ever reaches us, so the data is destroyed at the source
 * and no amount of decoding on our end recovers it.
 *
 * This is not theoretical: it corrupts `Get-CimInstance` output for non-ASCII
 * disk labels and GPU names, any path under a user profile with a non-ASCII
 * name, and every file the agent reads back through `read_file`.
 *
 * `[Console]::OutputEncoding` is the lever that applies to redirected streams,
 * which is what we always have (ssh2 exec / child_process). It can throw when
 * no console handle is attached, so it is guarded. UTF8Encoding($false)
 * suppresses the BOM that would otherwise prefix our first line of output.
 */
export const WINDOWS_UTF8_PREAMBLE = [
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}',
  '$OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
].join('\n');

/**
 * Build a single command line that executes `script` on the target OS.
 *
 * Windows: `-EncodedCommand` takes base64 of **UTF-16LE** — the single most
 * common way to get this wrong is encoding UTF-8 and getting mojibake or a
 * parse error. `-NoProfile` keeps a user's profile from injecting output into
 * stdout we would then try to parse.
 *
 * POSIX: pipe base64 into the shell. macOS ships BSD base64 whose decode flag
 * is `-D`; GNU coreutils uses `-d`. We know the family, so we pick correctly
 * rather than probing at runtime.
 */
export function wrapScript(script: string, os: OsFamily): string {
  if (os === 'windows') {
    const payload = `${WINDOWS_UTF8_PREAMBLE}\n${script}`;
    const encoded = Buffer.from(payload, 'utf16le').toString('base64');
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  }

  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const decodeFlag = os === 'macos' ? '-D' : '-d';
  // `printf %s` avoids echo's platform-dependent handling of backslashes.
  return `printf %s ${quoteArgPosix(encoded)} | base64 ${decodeFlag} | /bin/sh`;
}

/**
 * Wrap a script that must run as root.
 *
 * PRD §14: macOS sudo requires a TTY unless NOPASSWD is configured. `sudo -S`
 * reads the password from stdin, but our stdin is already carrying the base64
 * payload — so when a password is needed we decode to a temp file, feed the
 * password on stdin, and clean up. When NOPASSWD is available (the documented
 * recommendation) we take the simpler path.
 *
 * Windows has no sudo; elevation is a property of the SSH session's user, so
 * the script is returned unchanged and the caller is responsible for having
 * connected as an admin.
 */
export function wrapScriptElevated(
  script: string,
  os: OsFamily,
  sudoPassword?: string,
): string {
  if (os === 'windows') return wrapScript(script, os);

  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const decodeFlag = os === 'macos' ? '-D' : '-d';
  const b64 = quoteArgPosix(encoded);

  if (!sudoPassword) {
    return `printf %s ${b64} | base64 ${decodeFlag} | sudo -n /bin/sh`;
  }

  // Keep the password off the command line (it would show in `ps`), and keep
  // the script off stdin so sudo can own that channel.
  const tmp = `/tmp/.fleet-$$-$(date +%s%N 2>/dev/null || date +%s)`;
  return [
    `set -e`,
    `printf %s ${b64} | base64 ${decodeFlag} > ${tmp}`,
    `chmod 700 ${tmp}`,
    `sudo -S -p '' /bin/sh ${tmp} < /dev/stdin; rc=$?`,
    `rm -f ${tmp}`,
    `exit $rc`,
  ].join('\n');
}

/**
 * Render a `KEY=value` prefix for a command, escaped for the target shell.
 * Used by the provisioner to pass setup keys without embedding them in the
 * script body where they would land in logs.
 */
export function envPrefix(env: Record<string, string>, os: OsFamily): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return '';

  if (os === 'windows') {
    return entries
      .map(([k, v]) => `$env:${sanitizeEnvName(k)} = ${quoteArgPowerShell(v)}`)
      .join('; ') + '; ';
  }
  return entries
    .map(([k, v]) => `${sanitizeEnvName(k)}=${quoteArgPosix(v)}`)
    .join(' ') + ' ';
}

/**
 * Environment variable names are never user data in this codebase, but they do
 * get concatenated unquoted, so reject anything that isn't a plain identifier
 * rather than trusting the call sites.
 */
function sanitizeEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to build a command with unsafe env var name: ${JSON.stringify(name)}`);
  }
  return name;
}
