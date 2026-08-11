import { describe, expect, it } from 'vitest';
import { matchPeerToHost, normalizeHostname, type MeshPeer } from './types.js';

const peer = (hostname: string, over: Partial<MeshPeer> = {}): MeshPeer => ({
  id: `id-${hostname}`,
  hostname,
  ip: '100.0.0.1',
  connected: true,
  ...over,
});

describe('normalizeHostname', () => {
  it('collapses the ways a hostname gets mangled across providers', () => {
    // Every one of these is a real form this fleet's names take: the inventory
    // spelling, the Tailscale peer name, and the NetBird/OS hostname.
    expect(normalizeHostname("Revanth's MacBook Pro")).toBe('revanths-macbook-pro');
    expect(normalizeHostname('Revanth’s MacBook Pro')).toBe('revanths-macbook-pro');
    expect(normalizeHostname('Revanths-MacBook-Pro')).toBe('revanths-macbook-pro');
    expect(normalizeHostname('revanths-macbook-pro')).toBe('revanths-macbook-pro');
  });

  it('drops a trailing mDNS suffix consistently', () => {
    expect(normalizeHostname('Revanths-Mac-mini.local')).toBe('revanths-mac-mini-local');
  });

  it('does not merge distinct machines', () => {
    // The two Mac minis differ only by a trailing -2; collapsing them would
    // point the dashboard at the wrong host.
    expect(normalizeHostname('Revanths-Mac-mini')).not.toBe(
      normalizeHostname('Revanths-Mac-mini-2'),
    );
  });

  it('trims separators rather than leaving them dangling', () => {
    expect(normalizeHostname('  --Matha-Windows--  ')).toBe('matha-windows');
  });
});

describe('matchPeerToHost', () => {
  // The live Tailscale peer set on this fleet, verbatim.
  const peers = [
    peer('matha-windows-3080', { ip: '100.68.217.73', os: 'windows' }),
    peer('old6700k-ubuntu', { ip: '100.74.173.51', os: 'linux' }),
    peer('Revanth’s MacBook Pro', { ip: '100.86.8.24', os: 'macOS' }),
  ];

  it('matches across the apostrophe/casing gap', () => {
    const hit = matchPeerToHost(peers, {
      name: "Revanth's MacBook Pro",
      hostname: 'Revanths-MacBook-Pro-2',
    });
    expect(hit?.ip).toBe('100.86.8.24');
  });

  it('matches on the inventory hostname when it differs from the display name', () => {
    const hit = matchPeerToHost(peers, {
      name: 'Matha-Windows-3080-5TB',
      hostname: 'matha-windows-3080',
    });
    expect(hit?.ip).toBe('100.68.217.73');
  });

  it('returns null for a host that is not on the mesh yet', () => {
    // Both Mac minis are un-enrolled; the dashboard must show them as such
    // rather than silently binding to a neighbouring peer.
    expect(
      matchPeerToHost(peers, { name: 'Revanths-Mac-mini-2', hostname: 'Revanths-Mac-mini-2' }),
    ).toBeNull();
    expect(
      matchPeerToHost(peers, { name: "Revanth's Mac mini", hostname: 'Revanths-Mac-mini.local' }),
    ).toBeNull();
  });

  it('falls back to public key when the hostname changed', () => {
    const keyed = [peer('renamed-box', { ip: '100.9.9.9', publicKey: 'pubkey-abc' })];
    const hit = matchPeerToHost(keyed, {
      name: 'original-name',
      hostname: 'original-name',
      publicKey: '  pubkey-abc  ',
    });
    expect(hit?.ip).toBe('100.9.9.9');
  });

  it('matches via an explicit alias when no recorded name lines up', () => {
    // Host #1 is spelled three ways: `Matha-Windows-3080-5TB` in the sheet,
    // `MATHA-WINDOWS-3` by the OS, `matha-windows-3080` in the tailnet. None
    // normalise to each other, which is why aliases exist — and why the local
    // host is ultimately resolved via getSelfPeer() rather than by name.
    expect(
      matchPeerToHost(peers, {
        name: 'Matha-Windows-3080-5TB',
        hostname: 'Matha-Windows-3080-5TB',
      }),
    ).toBeNull();

    const hit = matchPeerToHost(peers, {
      name: 'Matha-Windows-3080-5TB',
      hostname: 'Matha-Windows-3080-5TB',
      aliases: ['matha-windows-3080'],
    });
    expect(hit?.ip).toBe('100.68.217.73');
  });

  it('prefers a hostname match over a public key match', () => {
    const both = [
      peer('wrong-host', { ip: '100.1.1.1', publicKey: 'shared' }),
      peer('right-host', { ip: '100.2.2.2', publicKey: 'other' }),
    ];
    const hit = matchPeerToHost(both, {
      name: 'right-host',
      hostname: 'right-host',
      publicKey: 'shared',
    });
    expect(hit?.ip).toBe('100.2.2.2');
  });
});
