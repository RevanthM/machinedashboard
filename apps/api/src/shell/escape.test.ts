import { describe, expect, it } from 'vitest';
import {
  envPrefix,
  isPosix,
  quoteArg,
  wrapScript,
  wrapScriptElevated,
  WINDOWS_UTF8_PREAMBLE,
  type OsFamily,
} from './escape.js';

const POSIX: OsFamily[] = ['ubuntu', 'debian', 'macos'];

/** Full decoded payload, preamble included. */
function decodeWindowsRaw(commandLine: string): string {
  const match = /-EncodedCommand (\S+)$/.exec(commandLine);
  if (!match?.[1]) throw new Error(`no -EncodedCommand in: ${commandLine}`);
  return Buffer.from(match[1], 'base64').toString('utf16le');
}

/**
 * Decode what we hand to `powershell.exe -EncodedCommand` and strip the fixed
 * encoding preamble, so assertions test the caller's script rather than our
 * boilerplate.
 */
function decodeWindows(commandLine: string): string {
  const raw = decodeWindowsRaw(commandLine);
  const prefix = `${WINDOWS_UTF8_PREAMBLE}\n`;
  if (!raw.startsWith(prefix)) {
    throw new Error('windows payload is missing the UTF-8 preamble');
  }
  return raw.slice(prefix.length);
}

function decodePosix(commandLine: string): string {
  const match = /printf %s '([A-Za-z0-9+/=]+)'/.exec(commandLine);
  if (!match?.[1]) throw new Error(`no base64 payload in: ${commandLine}`);
  return Buffer.from(match[1], 'base64').toString('utf8');
}

describe('isPosix', () => {
  it('classifies every family', () => {
    expect(POSIX.every(isPosix)).toBe(true);
    expect(isPosix('windows')).toBe(false);
  });
});

describe('wrapScript — round trip', () => {
  // If any of these survive the wrapper intact, hand-quoting bugs are gone.
  const payloads = [
    'echo hello',
    `echo 'single'`,
    `echo "double"`,
    'echo `backtick`',
    'echo $HOME && echo ${PATH}',
    'echo "$(whoami)"',
    'line one\nline two\r\nline three',
    'echo caf\u00e9 \u00fcber \u65e5\u672c\u8a9e \u{1F680}',
    'echo a\\b\\c',
    'echo %PATH% %%TEMP%%',
    "'; rm -rf / #",
    '"; Remove-Item -Recurse -Force C:\\ #',
    'echo ";DROP TABLE hosts;--"',
    '   leading and trailing whitespace   ',
    'tab\there',
  ];

  it.each(payloads)('windows preserves %j byte-for-byte', (script) => {
    expect(decodeWindows(wrapScript(script, 'windows'))).toBe(script);
  });

  it.each(POSIX.flatMap((os) => payloads.map((p) => [os, p] as const)))(
    '%s preserves %j byte-for-byte',
    (os, script) => {
      expect(decodePosix(wrapScript(script, os))).toBe(script);
    },
  );
});

describe('wrapScript — shape', () => {
  it('encodes PowerShell as UTF-16LE, not UTF-8', () => {
    const cmd = wrapScript('echo hi', 'windows');
    const b64 = /-EncodedCommand (\S+)$/.exec(cmd)![1]!;
    // UTF-16LE of ASCII interleaves NUL bytes; UTF-8 would not.
    expect(Buffer.from(b64, 'base64').includes(0x00)).toBe(true);
  });

  it('suppresses the PowerShell profile so stdout stays parseable', () => {
    expect(wrapScript('echo hi', 'windows')).toContain('-NoProfile');
    expect(wrapScript('echo hi', 'windows')).toContain('-NonInteractive');
  });

  // Regression: without this, PowerShell emits stdout in the console code page
  // and characters outside it (CJK, emoji) are replaced with literal `?` before
  // we ever see them. Caught by scripts/verify-shell-live.ts, not by unit tests.
  it('forces UTF-8 output encoding on Windows', () => {
    const raw = decodeWindowsRaw(wrapScript('Write-Output "hi"', 'windows'));
    expect(raw.startsWith(WINDOWS_UTF8_PREAMBLE)).toBe(true);
    expect(raw).toContain('[Console]::OutputEncoding');
    expect(raw).toContain('UTF8Encoding');
  });

  it('runs the caller script after the preamble, not before', () => {
    const raw = decodeWindowsRaw(wrapScript('Write-Output "marker"', 'windows'));
    expect(raw.indexOf('OutputEncoding')).toBeLessThan(raw.indexOf('marker'));
  });

  it('uses BSD -D on macOS and GNU -d on linux', () => {
    expect(wrapScript('x', 'macos')).toContain('base64 -D');
    expect(wrapScript('x', 'ubuntu')).toContain('base64 -d');
    expect(wrapScript('x', 'debian')).toContain('base64 -d');
  });

  it('emits a single line for POSIX so it can be handed to exec()', () => {
    for (const os of POSIX) {
      expect(wrapScript('a\nb\nc', os)).not.toContain('\n');
    }
  });

  it('never leaks raw script text into the command line', () => {
    const secretish = 'SUPERSECRETMARKER';
    for (const os of [...POSIX, 'windows'] as OsFamily[]) {
      expect(wrapScript(`echo ${secretish}`, os)).not.toContain(secretish);
    }
  });
});

describe('quoteArg', () => {
  it('makes embedded single quotes inert on POSIX', () => {
    expect(quoteArg(`it's`, 'ubuntu')).toBe(`'it'\\''s'`);
  });

  it('doubles single quotes for PowerShell', () => {
    expect(quoteArg(`it's`, 'windows')).toBe(`'it''s'`);
  });

  it('quotes the empty string rather than vanishing', () => {
    expect(quoteArg('', 'ubuntu')).toBe("''");
    expect(quoteArg('', 'windows')).toBe("''");
  });

  it('neutralises command substitution and separators', () => {
    for (const os of POSIX) {
      const q = quoteArg('$(id); rm -rf /', os);
      expect(q.startsWith("'")).toBe(true);
      expect(q.endsWith("'")).toBe(true);
      // No unescaped quote can terminate the literal early.
      expect(q.slice(1, -1)).not.toMatch(/(?<!\\)'/);
    }
  });
});

describe('wrapScriptElevated', () => {
  it('uses sudo -n when NOPASSWD is available', () => {
    const cmd = wrapScriptElevated('whoami', 'ubuntu');
    expect(cmd).toContain('sudo -n');
    expect(decodePosix(cmd)).toBe('whoami');
  });

  it('keeps the sudo password off the command line', () => {
    const cmd = wrapScriptElevated('whoami', 'macos', 'hunter2');
    expect(cmd).not.toContain('hunter2');
    expect(cmd).toContain('sudo -S');
  });

  it('cleans up the temp script even when the payload fails', () => {
    const cmd = wrapScriptElevated('exit 1', 'ubuntu', 'pw');
    expect(cmd).toContain('rm -f');
    expect(cmd).toContain('exit $rc');
  });

  it('is a no-op wrapper on Windows, where elevation is a session property', () => {
    expect(wrapScriptElevated('whoami', 'windows')).toBe(wrapScript('whoami', 'windows'));
  });
});

describe('envPrefix', () => {
  it('returns empty for no vars', () => {
    expect(envPrefix({}, 'ubuntu')).toBe('');
    expect(envPrefix({}, 'windows')).toBe('');
  });

  it('escapes values containing quotes and spaces', () => {
    expect(envPrefix({ KEY: `a'b c` }, 'ubuntu')).toBe(`KEY='a'\\''b c' `);
    expect(envPrefix({ KEY: `a'b c` }, 'windows')).toBe(`$env:KEY = 'a''b c'; `);
  });

  it('rejects env names that would break out of the prefix', () => {
    for (const bad of ['A B', 'A;rm -rf /', '1START', 'A-B', '']) {
      expect(() => envPrefix({ [bad]: 'v' }, 'ubuntu')).toThrow(/unsafe env var name/);
      expect(() => envPrefix({ [bad]: 'v' }, 'windows')).toThrow(/unsafe env var name/);
    }
  });
});
