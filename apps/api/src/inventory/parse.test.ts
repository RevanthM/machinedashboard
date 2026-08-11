import { describe, expect, it } from 'vitest';
import { normalizeOs, parseInventory, parseSshCommand } from './parse.js';
import { repairPemBody } from './keys.js';

describe('normalizeOs', () => {
  it('splits the real Ubuntu string into family, version and kernel', () => {
    expect(normalizeOs('Ubuntu 26.04 LTS (kernel 7.0.0-28-generic)')).toEqual({
      os: 'ubuntu',
      osVersion: '26.04 LTS',
      osKernel: '7.0.0-28-generic',
    });
  });

  it('handles the bare values the sheet uses', () => {
    expect(normalizeOs('Windows').os).toBe('windows');
    expect(normalizeOs('macOS').os).toBe('macos');
    expect(normalizeOs('Debian 12').os).toBe('debian');
  });

  it('returns null rather than guessing on unknown input', () => {
    expect(normalizeOs('TempleOS').os).toBeNull();
    expect(normalizeOs('').os).toBeNull();
  });
});

describe('parseSshCommand', () => {
  it('extracts the identity file the sheet only records here', () => {
    expect(parseSshCommand('ssh -i ~/.ssh/revanth_connect revanth@192.168.4.29')).toEqual({
      identityFile: '~/.ssh/revanth_connect',
      port: null,
      username: 'revanth',
      host: '192.168.4.29',
    });
  });

  it('ignores placeholder identity files', () => {
    // Row 3 of the real sheet literally says `-i <private_key_file>`.
    const parsed = parseSshCommand('ssh -i <private_key_file> revanthmatha@192.168.4.72');
    expect(parsed.identityFile).toBeNull();
    expect(parsed.username).toBe('revanthmatha');
  });

  it('extracts a non-default port', () => {
    expect(parseSshCommand('ssh -p 2222 me@box').port).toBe(2222);
  });

  it('is safe on empty input', () => {
    expect(parseSshCommand('').host).toBeNull();
  });
});

describe('repairPemBody', () => {
  // A structurally valid PEM whose base64 decodes cleanly.
  const body = Buffer.from('x'.repeat(200)).toString('base64');
  const wrapped = body.match(/.{1,70}/g)!.join('\n');
  const good = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;

  it('is a no-op on a well-formed key', () => {
    const result = repairPemBody(good);
    expect(result.wasWellFormed).toBe(true);
    expect(result.pem).toBe(good);
    expect(result.keyType).toBe('OPENSSH');
  });

  it('repairs a body whose newlines became double spaces', () => {
    // The corruption Appendix B.1 predicted. The real file does not have it,
    // but other exports of the same sheet might.
    const mangled = good.replace(/\n(?![-])/g, '  ');
    const result = repairPemBody(mangled);
    expect(result.pem).toBe(good);
    expect(result.wasWellFormed).toBe(false);
  });

  it('repairs CRLF and tab-separated bodies', () => {
    expect(repairPemBody(good.replace(/\n/g, '\r\n')).pem).toBe(good);
  });

  it('rejects a truncated body instead of writing an unusable key', () => {
    const truncated = good.replace(wrapped, wrapped.slice(0, 41));
    expect(() => repairPemBody(truncated)).toThrow(/base64|truncated|altered/i);
  });

  it('rejects input that is not a PEM at all', () => {
    expect(() => repairPemBody('just some text')).toThrow(/BEGIN\/END/);
  });

  it('rejects a header/footer mismatch', () => {
    const mismatched = good.replace('END OPENSSH', 'END RSA');
    expect(() => repairPemBody(mismatched)).toThrow(/mismatch/);
  });
});

describe('parseInventory', () => {
  const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(',')).join('\n'), 'utf8');

  it('accepts the minimal required column set', () => {
    const result = parseInventory(
      csv([
        ['Machine Name', 'LAN IP', 'Username'],
        ['box-a', '10.0.0.1', 'ops'],
      ]),
      'in.csv',
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.errors).toEqual([]);
    expect(result.rows[0]!.name).toBe('box-a');
    // Everything not in the sheet is defaulted, not rejected.
    expect(result.rows[0]!.sshPort).toBe(22);
    expect(result.rows[0]!.enableOllama).toBe(true);
  });

  it('flags rows that cannot identify a machine, without failing the batch', () => {
    const result = parseInventory(
      csv([
        ['Machine Name', 'LAN IP', 'Username'],
        ['good', '10.0.0.1', 'ops'],
        ['', '10.0.0.2', 'ops'],
        ['no-address', '', ''],
      ]),
      'in.csv',
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.errors).toEqual([]);
    expect(result.rows[1]!.errors).toContain('name is required');
    expect(result.rows[2]!.errors).toContain('username is required');
    expect(result.rows[2]!.errors.some((e) => e.includes('host address'))).toBe(true);
  });

  it('warns rather than errors when only a hostname is available', () => {
    // Row 4 of the real sheet: Revanths-Mac-mini-2 has no IP at all.
    const result = parseInventory(
      csv([
        ['Machine Name', 'Hostname', 'LAN IP', 'Username'],
        ['Revanths-Mac-mini-2', 'Revanths-Mac-mini-2', '', 'revanthmatha'],
      ]),
      'in.csv',
    );
    expect(result.rows[0]!.errors).toEqual([]);
    expect(result.rows[0]!.warnings.some((w) => w.includes('no IP address'))).toBe(true);
  });

  it('treats an em dash as an empty cell', () => {
    const result = parseInventory(
      csv([
        ['Machine Name', 'LAN IP', 'Username', 'Host Key Fingerprint'],
        ['box', '—', 'ops', '—'],
      ]),
      'in.csv',
    );
    expect(result.rows[0]!.host).toBeNull();
    expect(result.rows[0]!.knownHostKey).toBeNull();
  });

  it('defaults macOS to VNC and everything else to RDP', () => {
    const result = parseInventory(
      csv([
        ['Machine Name', 'LAN IP', 'Username', 'OS'],
        ['mac', '10.0.0.1', 'u', 'macOS'],
        ['win', '10.0.0.2', 'u', 'Windows'],
        ['ubu', '10.0.0.3', 'u', 'Ubuntu 26.04 LTS'],
      ]),
      'in.csv',
    );
    expect(result.rows[0]!.rdpProtocol).toBe('vnc');
    expect(result.rows[0]!.rdpPort).toBe(5900);
    expect(result.rows[1]!.rdpProtocol).toBe('rdp');
    expect(result.rows[2]!.rdpPort).toBe(3389);
  });

  it('infers auth method from what the sheet actually provides', () => {
    const result = parseInventory(
      csv([
        ['Machine Name', 'LAN IP', 'Username', 'SSH Command'],
        ['keyed', '10.0.0.1', 'u', 'ssh -i ~/.ssh/id_ed25519 u@10.0.0.1'],
        ['bare', '10.0.0.2', 'u', 'ssh u@10.0.0.2'],
      ]),
      'in.csv',
    );
    expect(result.rows[0]!.authMethod).toBe('key');
    expect(result.rows[0]!.keyPathHint).toBe('~/.ssh/id_ed25519');
    expect(result.rows[1]!.authMethod).toBe('agent');
  });

  it('is order- and case-independent about headers', () => {
    const result = parseInventory(
      csv([
        ['USERNAME', 'machine_name', 'ip address'],
        ['ops', 'box', '10.0.0.1'],
      ]),
      'in.csv',
    );
    expect(result.rows[0]!.name).toBe('box');
    expect(result.rows[0]!.username).toBe('ops');
    expect(result.rows[0]!.host).toBe('10.0.0.1');
  });
});
