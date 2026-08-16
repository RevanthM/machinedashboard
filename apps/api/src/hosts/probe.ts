/**
 * Reachability + auth probe (R-05).
 *
 * PRD §3: "Import validation must fail loudly and specifically ('port 22 closed
 * on 10.0.4.12') rather than silently retrying." The whole value of this module
 * is the specificity of its failures, so each stage is checked separately and
 * reports what it actually learned:
 *
 *   dns -> tcp -> ssh auth -> shell
 *
 * A generic "connection failed" would leave the operator guessing between a
 * sleeping machine, a missing sshd, a firewall, a wrong username, and a bad
 * key. Each of those has a different fix and a different owner.
 */
import { lookup } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { eq } from 'drizzle-orm';
import { hosts, type Host } from '../db/schema.js';
import { TransportError } from '../transport/types.js';
import { activeAddress, getTransport, type HostContext } from './service.js';

export type ProbeStage = 'address' | 'dns' | 'tcp' | 'auth' | 'shell';

export interface ProbeResult {
  hostId: string;
  name: string;
  ok: boolean;
  address: string | null;
  addressSource: 'mesh' | 'inventory' | 'hostname' | null;
  reachedStage: ProbeStage;
  failedStage?: ProbeStage;
  error?: string;
  /** What the operator should do about it. Empty when ok. */
  remedy?: string;
  osDetected?: string;
  durationMs: number;
}

export async function probeHost(ctx: HostContext, host: Host): Promise<ProbeResult> {
  const started = Date.now();
  const resolved = activeAddress(host);

  const base = {
    hostId: host.id,
    name: host.name,
    address: resolved?.address ?? null,
    addressSource: resolved?.source ?? null,
  };

  const fail = (
    failedStage: ProbeStage,
    reachedStage: ProbeStage,
    error: string,
    remedy: string,
  ): ProbeResult => ({
    ...base,
    ok: false,
    reachedStage,
    failedStage,
    error,
    remedy,
    durationMs: Date.now() - started,
  });

  if (!resolved) {
    return fail(
      'address',
      'address',
      'No usable address.',
      'Add a LAN IP or hostname to the inventory, or enroll this host in the mesh. ' +
        'Mac mini #2 has no address recorded at all (P-04).',
    );
  }

  // --- DNS ------------------------------------------------------------------
  let ip = resolved.address;
  if (!isIpLiteral(resolved.address)) {
    try {
      const record = await lookup(resolved.address);
      ip = record.address;
    } catch {
      return fail(
        'dns',
        'address',
        `Cannot resolve "${resolved.address}".`,
        resolved.source === 'hostname'
          ? `No IP is recorded for this host, and "${resolved.address}" does not resolve. ` +
            `Add its IP to the inventory, or ensure mDNS (.local) resolution works from here.`
          : `Check the hostname, or replace it with an IP address.`,
      );
    }
  }

  // --- TCP ------------------------------------------------------------------
  const tcp = await checkTcp(ip, host.sshPort, 6_000);
  if (!tcp.open) {
    return fail(
      'tcp',
      'dns',
      `Port ${host.sshPort} ${tcp.reason} on ${ip}.`,
      tcp.reason === 'closed'
        ? `sshd is not listening. See PREREQS.md for this host's OS — on Windows the ` +
          `OpenSSH Server feature and its firewall rule are separate steps (P-01).`
        : `No response — the machine may be asleep, or a firewall is dropping packets. ` +
          `If it is only reachable over the mesh, confirm its peer is connected.`,
    );
  }

  // --- SSH auth + shell -----------------------------------------------------
  try {
    const transport = await getTransport(ctx, host);
    const probeCmd = transport.os === 'windows' ? 'Write-Output fleet-ok' : 'echo fleet-ok';
    const result = await transport.exec(probeCmd, { timeoutMs: 20_000 });

    if (!result.stdout.includes('fleet-ok')) {
      return fail(
        'shell',
        'auth',
        `Authenticated, but the shell did not echo correctly (exit ${result.exitCode}).`,
        transport.os === 'windows'
          ? `The default SSH shell may still be cmd.exe. Set PowerShell as the default ` +
            `shell — see PREREQS.md (P-01).`
          : `Check the login shell for ${host.username}; a noisy profile can corrupt output.`,
      );
    }

    return {
      ...base,
      ok: true,
      reachedStage: 'shell',
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof TransportError) {
      switch (err.kind) {
        case 'auth_failed':
          return fail(
            'auth',
            'tcp',
            err.message,
            `Verify the username and credential. For key auth, confirm the public key is ` +
              `in ~/.ssh/authorized_keys on the host and the key file is readable here.`,
          );
        case 'host_key_changed':
          return fail(
            'auth',
            'tcp',
            err.message,
            `The host key changed. If you rebuilt this machine, clear its pinned key and ` +
              `re-probe. Otherwise stop and investigate — this is what pinning is for.`,
          );
        case 'timeout':
          return fail('auth', 'tcp', err.message, `The host accepted the connection but did not complete the handshake.`);
        default:
          return fail('auth', 'tcp', err.message, err.detail ?? 'See the API log for detail.');
      }
    }
    return fail('auth', 'tcp', (err as Error).message, 'Unexpected error; see the API log.');
  }
}

/** Probe a host and write the outcome back to its record. */
export async function probeAndRecord(ctx: HostContext, host: Host): Promise<ProbeResult> {
  const result = await probeHost(ctx, host);
  const now = Math.floor(Date.now() / 1000);

  await ctx.db
    .update(hosts)
    .set({
      status: result.ok
        ? 'online'
        : result.failedStage === 'auth'
          ? 'auth_failed'
          : 'unreachable',
      lastSeenAt: result.ok ? now : undefined,
      lastCheckedAt: now,
      lastError: result.ok ? null : `${result.error} ${result.remedy ?? ''}`.trim(),
      updatedAt: now,
    })
    .where(eq(hosts.id, host.id));

  return result;
}

function isIpLiteral(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

function checkTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ open: boolean; reason: 'open' | 'closed' | 'timed out' | 'unreachable' }> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const done = (open: boolean, reason: 'open' | 'closed' | 'timed out' | 'unreachable') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise({ open, reason });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, 'open'));
    socket.once('timeout', () => done(false, 'timed out'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      done(false, err.code === 'ECONNREFUSED' ? 'closed' : 'unreachable');
    });
  });
}
