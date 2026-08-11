/**
 * Executes wrapScript() output against a real shell on the machine running it.
 *
 * The unit tests prove the encoding round-trips; this proves the shell actually
 * accepts what we produce. Run it on each OS family you manage — a payload that
 * decodes correctly in Node can still be rejected by the shell's parser.
 *
 *   npx tsx scripts/verify-shell-live.ts
 */
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { wrapScript, type OsFamily } from '../src/shell/escape.js';

type Case = [name: string, script: string, expected: string];

const WINDOWS_CASES: Case[] = [
  ['plain', `Write-Output "hello"`, 'hello'],
  ['single quotes', `Write-Output 'it''s here'`, "it's here"],
  ['double quotes', `Write-Output "she said ""hi"""`, 'she said "hi"'],
  ['dollar literal vs expanded', `$x = 'v'; Write-Output "val=$x lit=\`$x"`, 'val=v lit=$x'],
  ['shell metacharacters', `Write-Output "a;b&c|d"`, 'a;b&c|d'],
  ['unicode', `Write-Output "caf\u00e9 \u00fcber \u65e5\u672c\u8a9e \u{1F680}"`, 'caf\u00e9 \u00fcber \u65e5\u672c\u8a9e \u{1F680}'],
  ['multiline script', `$a = 1\n$b = 2\nWrite-Output ($a + $b)`, '3'],
  ['destructive-looking literal', `Write-Output '"; Remove-Item -Recurse -Force C:\\ #'`, '"; Remove-Item -Recurse -Force C:\\ #'],
  ['path with spaces', `Write-Output 'C:\\Program Files\\Tailscale'`, 'C:\\Program Files\\Tailscale'],
];

const POSIX_CASES: Case[] = [
  ['plain', `printf '%s' hello`, 'hello'],
  ['single quotes', `printf '%s' "it's here"`, "it's here"],
  ['double quotes', `printf '%s' 'she said "hi"'`, 'she said "hi"'],
  ['dollar literal vs expanded', `x=v; printf '%s' "val=$x lit=\\$x"`, 'val=v lit=$x'],
  ['shell metacharacters', `printf '%s' 'a;b&c|d'`, 'a;b&c|d'],
  ['unicode', `printf '%s' 'caf\u00e9 \u00fcber \u65e5\u672c\u8a9e \u{1F680}'`, 'caf\u00e9 \u00fcber \u65e5\u672c\u8a9e \u{1F680}'],
  ['multiline script', `a=1\nb=2\nprintf '%s' $((a + b))`, '3'],
  ['destructive-looking literal', `printf '%s' "'; rm -rf / #"`, "'; rm -rf / #"],
  ['path with spaces', `printf '%s' '/Volumes/Macintosh HD'`, '/Volumes/Macintosh HD'],
];

function detectFamily(): OsFamily {
  switch (platform()) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'ubuntu';
  }
}

const os = detectFamily();
const cases = os === 'windows' ? WINDOWS_CASES : POSIX_CASES;
console.log(`Verifying wrapScript() against a live shell as os=${os}\n`);

let pass = 0;
let fail = 0;

for (const [name, script, expected] of cases) {
  const commandLine = wrapScript(script, os);
  try {
    const raw = execSync(commandLine, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    const actual = raw.replace(/\r?\n$/, '');
    if (actual === expected) {
      console.log(`  PASS   ${name}`);
      pass++;
    } else {
      console.log(`  FAIL   ${name}`);
      console.log(`         expected ${JSON.stringify(expected)}`);
      console.log(`         actual   ${JSON.stringify(actual)}`);
      fail++;
    }
  } catch (err) {
    console.log(`  ERROR  ${name}: ${String((err as Error).message).split('\n')[0]}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed against live ${os} shell`);
process.exit(fail === 0 ? 0 : 1);
