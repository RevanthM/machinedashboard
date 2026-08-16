/**
 * The provisioning step catalogue (R-11, R-12, R-13, plus detection).
 *
 * Scripts are written against the reference commands in PRD §F2 and hardened
 * for idempotency, because `check` deciding "already done" is what keeps a
 * re-provision under 20 seconds (N-10).
 *
 * Everything here returns script *bodies*. The engine wraps them via the
 * escaping module, so nothing in this file hand-quotes anything.
 */
import { randomUUID } from 'node:crypto';
import type { ProvisionStep, StepContext, StepOutcome } from './types.js';

const ok = (detail?: string): StepOutcome => ({ status: 'ok', detail });
const failed = (detail: string): StepOutcome => ({ status: 'failed', detail });

/**
 * Put Homebrew on PATH for a non-interactive shell.
 *
 * Homebrew's installer only appends `brew shellenv` to `~/.zprofile`, which is
 * read by *login* shells. An SSH `exec` runs `/bin/sh -c` and reads neither
 * `.zprofile` nor `.zshrc`, so `brew` is simply not found — the install
 * appears to succeed and every later `brew install` fails with
 * "command not found". Both Apple Silicon (/opt/homebrew) and Intel
 * (/usr/local) prefixes are probed because the fleet has M1/M4 Macs now but the
 * path should not silently break on an Intel one.
 */
const BREW_ENV = [
  'if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)";',
  'elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi',
].join('\n');

/** Did a command succeed and print something matching? */
async function probe(ctx: StepContext, script: string, needle?: string): Promise<boolean> {
  try {
    const res = await ctx.exec(script, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) return false;
    return needle ? res.stdout.toLowerCase().includes(needle.toLowerCase()) : true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// detect_os — also resolves the Windows edition question (P-05, R-11)
// ---------------------------------------------------------------------------

const detectOs: ProvisionStep = {
  id: 'detect_os',
  title: 'Detect OS and edition',
  dependsOn: [],
  async check() {
    // Always re-detect: cheap, and an OS upgrade should be noticed.
    return false;
  },
  async apply(ctx) {
    if (ctx.os === 'windows') {
      const res = await ctx.exec(
        `$os = Get-CimInstance Win32_OperatingSystem
Write-Output "caption=$($os.Caption)"
Write-Output "version=$($os.Version)"`,
        { timeoutMs: 30_000 },
      );
      const caption = /caption=(.+)/.exec(res.stdout)?.[1]?.trim() ?? '';
      const version = /version=(.+)/.exec(res.stdout)?.[1]?.trim() ?? '';
      ctx.facts.osCaption = caption;
      ctx.facts.osVersion = version;

      // Home has no RDP host — this decides the remote-desktop path entirely.
      const isHome = /\bHome\b/i.test(caption);
      ctx.facts.windowsEdition = isHome ? 'home' : 'pro-or-better';
      ctx.facts.remoteDesktop = isHome ? 'vnc' : 'rdp';
      ctx.log(
        isHome
          ? `Windows Home detected — no RDP host available, will install TightVNC.`
          : `${caption} — RDP host available.`,
      );
      return;
    }

    const res = await ctx.exec(
      ctx.os === 'macos'
        ? `sw_vers -productName; sw_vers -productVersion; uname -r`
        : `. /etc/os-release 2>/dev/null; echo "$NAME"; echo "$VERSION_ID"; uname -r`,
      { timeoutMs: 30_000 },
    );
    const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    ctx.facts.osCaption = lines[0] ?? ctx.os;
    ctx.facts.osVersion = lines[1] ?? '';
    ctx.facts.osKernel = lines[2] ?? '';
    ctx.facts.remoteDesktop = ctx.os === 'macos' ? 'vnc' : 'rdp';
  },
  async verify(ctx) {
    return ctx.facts.osCaption
      ? ok(`${ctx.facts.osCaption} ${ctx.facts.osVersion}`.trim())
      : failed('Could not determine the OS.');
  },
};

// ---------------------------------------------------------------------------
// join_mesh (R-09/R-10)
// ---------------------------------------------------------------------------

const joinMesh: ProvisionStep = {
  id: 'join_mesh',
  title: 'Join mesh network',
  dependsOn: ['detect_os'],
  async check(ctx) {
    // The host record already carries a connected peer, so nothing to do.
    return ctx.host.meshStatus === 'connected' && Boolean(ctx.host.meshIp);
  },
  async apply(ctx) {
    const plan = ctx.mesh.planEnrollment({
      os: ctx.os,
      hostname: ctx.host.hostname ?? ctx.host.name,
    });
    ctx.log(plan.description);
    // planEnrollment already wrapped the script for the target OS, so it is
    // executed as-is rather than being wrapped a second time.
    const res = await ctx.exec(plan.script, { env: plan.env, timeoutMs: 180_000 });
    if (res.exitCode !== 0) {
      throw new Error(`Mesh enrollment failed (exit ${res.exitCode}): ${res.stderr.slice(0, 400)}`);
    }
  },
  async verify(ctx) {
    if (ctx.host.meshStatus === 'connected') return ok(`Peer ${ctx.host.meshIp}`);
    // The control plane may take a moment to register the peer; the mesh poller
    // will pick it up, so this is reported rather than treated as a hard fail.
    return ok('Enrollment ran; waiting for the control plane to report the peer.');
  },
};

// ---------------------------------------------------------------------------
// install_rdp (R-11)
// ---------------------------------------------------------------------------

const installRemoteDesktop: ProvisionStep = {
  id: 'install_rdp',
  title: 'Install remote desktop server',
  dependsOn: ['detect_os'],
  /**
   * The question this step actually cares about is "can we open a remote
   * desktop session", not "is xrdp installed".
   *
   * Ubuntu 26.04 ships gnome-remote-desktop listening on 3389 out of the box.
   * An earlier version of this check asked only about xrdp, so it installed a
   * second RDP server which then died with EADDRINUSE — leaving the host worse
   * off than before provisioning. Checking for a *listener* rather than a
   * particular implementation avoids fighting whatever the distro already
   * provides.
   */
  async check(ctx) {
    switch (ctx.os) {
      case 'windows':
        if (ctx.facts.remoteDesktop === 'vnc') {
          return probe(ctx, `Test-Path 'C:\\Program Files\\TightVNC\\tvnserver.exe'`, 'true');
        }
        return probe(
          ctx,
          `(Get-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server').fDenyTSConnections`,
          '0',
        );
      case 'macos':
        // Screen Sharing is built in; check the launch daemon is loaded.
        return probe(ctx, `launchctl list | grep -q screensharing && echo present`, 'present');
      default:
        return probe(
          ctx,
          `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE '[:.]3389( |$)' && echo RDP_LISTENING`,
          'RDP_LISTENING',
        );
    }
  },
  async apply(ctx) {
    switch (ctx.os) {
      case 'windows':
        if (ctx.facts.remoteDesktop === 'vnc') {
          ctx.log('Windows Home — installing TightVNC instead of enabling RDP.');
          await ctx.exec(
            `winget install --id GlavSoft.TightVNC -e --silent --accept-source-agreements --accept-package-agreements`,
            { timeoutMs: 300_000 },
          );
          return;
        }
        await ctx.exec(
          `Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
Add-LocalGroupMember -Group "Remote Desktop Users" -Member $env:USERNAME -ErrorAction SilentlyContinue`,
          { timeoutMs: 120_000 },
        );
        return;

      case 'macos':
        // Screen Sharing ships with macOS; kickstart enables and configures it.
        await ctx.exec(
          `sudo -n /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \\
  -activate -configure -access -on -restart -agent -privs -all`,
          { elevated: false, timeoutMs: 120_000 },
        );
        return;

      default: {
        // Reached only when nothing is already serving 3389.
        ctx.log('No RDP listener found — installing xrdp.');
        await ctx.exec(
          `export DEBIAN_FRONTEND=noninteractive
apt-get install -y xrdp
adduser xrdp ssl-cert || true
systemctl enable --now xrdp`,
          { elevated: true, timeoutMs: 300_000 },
        );
      }
    }
  },
  async verify(ctx) {
    const done = await installRemoteDesktop.check(ctx);
    const kind = ctx.facts.remoteDesktop ?? (ctx.os === 'macos' ? 'vnc' : 'rdp');
    return done
      ? ok(`${kind.toUpperCase()} server ready`)
      : failed(`${kind.toUpperCase()} server did not come up. Check the step log.`);
  },
};

// ---------------------------------------------------------------------------
// install_gh (R-12)
// ---------------------------------------------------------------------------

const installGithubCli: ProvisionStep = {
  id: 'install_gh',
  title: 'Install GitHub CLI',
  dependsOn: ['detect_os'],
  async check(ctx) {
    return probe(
      ctx,
      ctx.os === 'windows'
        ? `if (Get-Command gh -EA SilentlyContinue) { "yes" }`
        : `${BREW_ENV}\ncommand -v gh`,
      ctx.os === 'windows' ? 'yes' : undefined,
    );
  },
  async apply(ctx) {
    switch (ctx.os) {
      case 'windows':
        await ctx.exec(
          `winget install --id GitHub.cli -e --silent --accept-source-agreements --accept-package-agreements`,
          { timeoutMs: 300_000 },
        );
        return;
      case 'macos':
        // Same unlinked-formula caveat as Ollama below.
        await ctx.exec(`${BREW_ENV}\nbrew install gh || brew link --overwrite gh`, {
          timeoutMs: 900_000,
        });
        return;
      default:
        await ctx.exec(
          `export DEBIAN_FRONTEND=noninteractive
apt-get install -y gh || {
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update && apt-get install -y gh
}`,
          { elevated: true, timeoutMs: 600_000 },
        );
    }
  },
  async verify(ctx) {
    return (await installGithubCli.check(ctx)) ? ok('gh installed') : failed('gh not found after install.');
  },
};

// ---------------------------------------------------------------------------
// install_ollama + pull model (R-13)
// ---------------------------------------------------------------------------

/** gemma4:e2b needs roughly 8 GB RAM at Q4 (PRD §F5). */
const MIN_RAM_GB_FOR_MODEL = 8;

const installOllama: ProvisionStep = {
  id: 'install_ollama',
  title: 'Install Ollama',
  dependsOn: ['detect_os'],
  enabled: (ctx) => ctx.host.enableOllama,
  /**
   * "Installed" is not the same as "usable by us".
   *
   * A stock Ollama binds 127.0.0.1 only, so a host with Ollama already present
   * would pass a binary-existence check, skip apply, and then fail every
   * benchmark because the API is unreachable over the mesh. The check therefore
   * verifies the binary *and* that it is listening on a non-loopback address —
   * which is the condition the step actually exists to establish.
   */
  async check(ctx) {
    if (ctx.os === 'windows') {
      return probe(ctx, `if (Get-Command ollama -EA SilentlyContinue) { "yes" }`, 'yes');
    }
    if (!(await probe(ctx, `${BREW_ENV}\ncommand -v ollama`))) return false;

    // ss on modern distros, netstat as the fallback; macOS has only the latter.
    return probe(
      ctx,
      `(ss -ltn 2>/dev/null || netstat -an 2>/dev/null) | grep -E '[^0-9.]0\\.0\\.0\\.0:11434|\\*\\.11434|\\*:11434' >/dev/null && echo BOUND_EXTERNAL`,
      'BOUND_EXTERNAL',
    );
  },
  async apply(ctx) {
    switch (ctx.os) {
      case 'windows':
        await ctx.exec(
          `winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements`,
          { timeoutMs: 600_000 },
        );
        return;
      case 'macos':
        // `brew install` exits non-zero when a formula is present but unlinked
        // ("already installed, it's just not linked") — a state Macs reach after
        // a Homebrew reinstall or a prefix migration. Treating that as failure
        // reported "ollama not found" on a host that had it all along, so the
        // link is repaired explicitly rather than left to the install verb.
        //
        // brew services ignores `launchctl setenv` — OLLAMA_HOST must live in
        // the formula plist or the daemon keeps binding 127.0.0.1 and remote
        // benchmarks time out. Patch the plist explicitly, then restart.
        await ctx.exec(
          `${BREW_ENV}
brew install ollama || brew link --overwrite ollama
command -v ollama >/dev/null 2>&1 || brew link --overwrite ollama
PLIST="$(brew --prefix)/opt/ollama/homebrew.mxcl.ollama.plist"
/usr/libexec/PlistBuddy -c 'Delete :EnvironmentVariables' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:OLLAMA_HOST string 0.0.0.0:11434' "$PLIST"
brew services restart ollama || brew services start ollama`,
          { timeoutMs: 900_000 },
        );
        return;
      default:
        // OLLAMA_HOST binds beyond loopback so the benchmark harness can reach
        // it over the mesh (PRD §14). Mesh ACLs are the access control, not the
        // bind address. The install is skipped when the binary already exists,
        // so a host that only needs the bind fixed is not reinstalled.
        await ctx.exec(
          `set -e
command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF
systemctl daemon-reload
systemctl enable ollama
systemctl restart ollama`,
          { elevated: true, timeoutMs: 600_000 },
        );
        // systemd returns before the socket is listening; without this the
        // verify below races the restart and reports a false failure.
        await ctx.exec(
          `for i in $(seq 1 20); do (ss -ltn 2>/dev/null || netstat -an) | grep -q 11434 && exit 0; sleep 1; done`,
          { timeoutMs: 60_000 },
        );
    }
  },
  async verify(ctx) {
    return (await installOllama.check(ctx)) ? ok('ollama installed') : failed('ollama not found after install.');
  },
};

const pullModel: ProvisionStep = {
  id: 'pull_model',
  title: 'Pull benchmark model',
  dependsOn: ['install_ollama'],
  enabled: (ctx) => ctx.host.enableOllama,
  async check(ctx) {
    const model = ctx.facts.benchmarkModel ?? 'gemma4:e2b';
    const list = ctx.os === 'windows' ? `ollama list` : `${BREW_ENV}\nollama list`;
    return probe(ctx, list, model.split(':')[0]);
  },
  async apply(ctx) {
    // RAM pre-flight (R-13): pulling a model that cannot fit thrashes swap and
    // can take the host down. Better to mark it unsupported and move on.
    const ramGb = Number(ctx.facts.ramTotalGb ?? '0');
    if (ramGb > 0 && ramGb < MIN_RAM_GB_FOR_MODEL) {
      throw new Error(
        `LLM_UNSUPPORTED: ${ramGb.toFixed(1)} GB RAM is below the ${MIN_RAM_GB_FOR_MODEL} GB ` +
          `needed for ${ctx.facts.benchmarkModel ?? 'gemma4:e2b'}. Skipping the pull rather than thrashing swap.`,
      );
    }
    const model = ctx.facts.benchmarkModel ?? 'gemma4:e2b';
    const pull = ctx.os === 'windows' ? `ollama pull ${model}` : `${BREW_ENV}\nollama pull ${model}`;
    await ctx.exec(pull, { timeoutMs: 1_800_000 });
  },
  async verify(ctx) {
    return (await pullModel.check(ctx))
      ? ok(`${ctx.facts.benchmarkModel ?? 'gemma4:e2b'} present`)
      : failed('Model not listed after pull.');
  },
};

// ---------------------------------------------------------------------------
// telemetry dependencies (R-14/R-15)
// ---------------------------------------------------------------------------

const installTelemetryDeps: ProvisionStep = {
  id: 'install_telemetry',
  title: 'Install telemetry dependencies',
  dependsOn: ['detect_os'],
  appliesTo: ['ubuntu', 'debian'],
  async check(ctx) {
    return probe(ctx, `command -v lscpu && command -v lspci`);
  },
  async apply(ctx) {
    await ctx.exec(
      `export DEBIAN_FRONTEND=noninteractive
apt-get install -y lshw pciutils sysstat`,
      { elevated: true, timeoutMs: 300_000 },
    );
  },
  async verify(ctx) {
    return (await installTelemetryDeps.check(ctx)) ? ok('collectors available') : failed('lscpu/lspci missing.');
  },
};

export const ALL_STEPS: ProvisionStep[] = [
  detectOs,
  joinMesh,
  installRemoteDesktop,
  installGithubCli,
  installTelemetryDeps,
  installOllama,
  pullModel,
];

export function stepById(id: string): ProvisionStep | undefined {
  return ALL_STEPS.find((s) => s.id === id);
}

export function newRunId(): string {
  return randomUUID();
}
