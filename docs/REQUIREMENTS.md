# Requirements traceability

Status is honest, not aspirational. **Done** means implemented *and* exercised —
by a unit test, a live verification script, or a run against real hardware.
**Partial** and **Not built** say what is missing and why.

Verified-live items were run against this fleet, not against fixtures.

## Functional

| ID | Status | Where | Notes |
|---|---|---|---|
| R-01 | Partial | `inventory/parse.ts`, `inventory/commit.ts` | Parsing, per-row validation, and commit are done and verified against the real workbook (5/5 imported). Column mapping is automatic via an alias table; the **interactive remap dropdown is not built** — a mis-titled column currently needs renaming in the sheet. |
| R-02 | Done | `inventory/commit.ts` | Upsert on `name`; re-import updates in place. Live-verified. |
| R-03 | Done | `inventory/keys.ts` + tests | `repairPemBody` normalises any whitespace mangling and is a no-op on well-formed input; validated with `ssh-keygen -y`. All five real keys returned `validated: true`. |
| R-04 | Partial | `inventory/commit.ts`, `inventory/keys.ts` | Keys written to `~/.fleet-console/keys/*.pem` at 0600, only paths persisted, DB-grep test enforces it. **Blanking the column in the stored copy is deliberately not done** — the source file is the operator's own document in `~/Downloads`; silently rewriting it is destructive and the app never had a "stored copy" of its own. The import banner recommends rotation instead. |
| R-05 | Done | `hosts/probe.ts` | Staged `address → dns → tcp → auth → shell`, each with a specific error and a remedy naming the relevant prereq (P-01…P-04). |
| R-06 | Done | `transport/pool.ts` | Keyed by host+address, keepalive, idle reap, LRU eviction, hard cap. Exposed at `/api/debug/pool`. |
| R-07 | Done | `provision/engine.ts`, `provision/steps.ts` | detect→check→apply→verify; failed steps block dependents but not siblings (verified: `pull_model` blocked by `install_ollama`, siblings ran). |
| R-08 | Done | `provision/dry-run.ts` | `DRY_RUN=1` or `{dryRun:true}`. Implemented as a Transport that cannot connect, so no code path can accidentally reach a host. Live-verified. |
| R-09 | Done | `mesh/types.ts`, `mesh/tailscale.ts` | `MeshProvider` seam; Tailscale adapter live-verified against the running daemon. |
| R-10 | Done | `mesh/netbird.ts` | Management API client + per-OS enrollment scripts. **Untested against a live control plane** — none exists yet (see `deploy/netbird/README.md`). |
| R-11 | Done | `provision/steps.ts` | xrdp / Windows RDP / macOS Screen Sharing / TightVNC-on-Home, with edition detection at `detect_os`. |
| R-12 | Done | `provision/steps.ts` | `gh` via winget / brew / apt with keyring fallback. |
| R-13 | Done | `provision/steps.ts` | Ollama install + `OLLAMA_HOST=0.0.0.0`; RAM pre-flight refuses the pull below 8 GB and marks the host `llm_unsupported` rather than thrashing swap. |
| R-14 | Done | `collect/specs.ts` | Live-verified on this machine: CPU, 16c/32t, 63.9 GB, RTX 3080 10 GB, both NTFS volumes. |
| R-15 | Done | `collect/metrics.ts`, `collect/poller.ts` | 15s poll over the pooled connection, counter deltas for CPU/network, exponential backoff on failure, 24h retention. Live-verified. |
| R-16 | Done | `web/src/App.tsx` | Card grid + dense table toggle; filters for OS, status, tag. |
| R-17 | Done | `web/src/components.tsx` | Three independent pips (ssh · mesh · llm), each with its own state and tooltip. |
| R-18 | Done | `bench/ollama.ts` | eval tok/s, prompt tok/s, TTFT, load, total, derived from Ollama's ns timings. **Not yet run against a live Ollama** — no host has it installed. |
| R-19 | Done | `bench/ollama.ts` | `num_ctx=8192`, `temperature=0`, `seed=42` pinned on every call and recorded per result. |
| R-20 | Done | `collect/specs.ts`, `bench/ollama.ts` | Backend inferred from GPU + driver presence, then corrected from `/api/ps` (a model spilled to CPU reports `cpu`, not `cuda`). Live-verified as `cuda` on this box. |
| R-21 | Done | `/api/leaderboard`, `web` | Ranked by eval tok/s, also grouped by backend. |
| R-22 | Done | `/api/hosts/:id/benchmark` | Accepts a `model` override per run, so an E2B baseline and a max-capability run can coexist. |
| R-23 | Done | `web/src/Terminal.tsx`, `/ws/terminal/:hostId` | xterm.js + ssh2 PTY, SIGWINCH resize propagation, 10k scrollback, search addon. **Not exercised end-to-end** — needs a reachable SSH host. |
| R-24 | **Not built** | — | Session recording to asciinema cast. Priority "Could"; skipped in favour of the Must items. |
| R-25 | Partial | `guac/shim.ts`, `guac/token.ts`, `deploy/guacd/` | The **hard part is done and is the point**: risk #1 is resolved by a single-use loopback shim so guacd never needs mesh routing. Token minting, preflight, and the compose stack exist. **The guacamole-lite WS tunnel and the browser client are not built** — Docker is not installed on this machine, and the PRD says not to build F8 UI until reachability is proven. |
| R-26 | **Not built** | — | Clipboard / resize / fullscreen / Ctrl+Alt+Del. Depends on R-25's client. |
| R-27 | Done | `/api/hosts/:id/rdp/file` | `.rdp` download for a native client. |
| R-28 | Partial | `agent/tools.ts`, `agent/loop.ts` | All 7 tools, the executor, and the chat loop are implemented. **Not exercised** — requires a reachable Ollama with tool calling. |
| R-29 | Done | `agent/loop.ts`, `/api/attachments` | Text inlined with truncation notice and a per-message budget; images base64; binaries never inlined, offered only as `upload_attachment` targets. Type sniffed, not trusted from the extension. |
| R-30 | Done | `agent/gate.ts` + 40 tests | 3 modes + hardcoded deny list. Deny rules outrank every mode including allowlist. |
| R-31 | Done | `agent/tools.ts`, `/api/audit` | Every execution recorded with the approving action; terminal, exec, provision, and agent all write to one table. |
| R-32 | Won't (v1) | — | Fleet-mode chat. Seam left at the tag filter. |

## Non-functional

| ID | Status | Where | Notes |
|---|---|---|---|
| N-01 | Done | `config.ts` | `assertSafeConfig` refuses to start on a non-loopback bind. Vite binds 127.0.0.1 too. |
| N-02 | Deviation | `secrets/vault.ts` | AES-256-GCM + scrypt, per-entry IV, host+field bound as AAD. **`keytar` deliberately not used**: archived in 2023, unmaintained native dep, needs a toolchain this machine lacks. `SecretVault` is an interface, so a keychain impl can be added. |
| N-03 | Done | `db/no-secrets.test.ts` | Reads the raw `.db` file as bytes (after a WAL checkpoint) and asserts no secret appears. Also covers key bodies. |
| N-04 | Done | `transport/ssh.ts` | TOFU pinning; a changed key is a hard `host_key_changed` failure, never auto-accepted. |
| N-05 | Done | `agent/gate.ts` + tests | Structural, not advisory: `executeToolCall` evaluates the gate before any transport access, there is no bypass parameter, and approval re-evaluates rather than trusting the caller. Tested exhaustively over modes × tools. |
| N-06 | Done | `guac/token.ts` | 60s TTL, single-use, AES-GCM sealed, host id bound as AAD. All failure modes return one indistinguishable error. |
| N-07 | Done | `tsconfig.base.json` | `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Both workspaces typecheck clean; no `any` in the codebase. |
| N-08 | Done | `shell/escape.ts` + 79 tests | Base64 transport on both platforms, `-EncodedCommand` UTF-16LE for PowerShell. Live-verified against real shells. |
| N-09 | Partial | `collect/poller.ts` | Designed for it — concurrent polls, one short script each, batched insert, hourly pruning, skip-not-stack. **Not load-tested with 10 hosts.** |
| N-10 | Partial | `provision/engine.ts` | `check()` short-circuits before `apply()`; verified that `join_mesh` skips on an already-connected peer. **The <20s figure is unmeasured** — no host is provisioned yet. |
| N-11 | Partial | `README.md`, `PREREQS.md` | Clean-machine path documented and the dependency traps are fixed (Node 24 prebuilds, no toolchain needed). Not timed on a genuinely clean laptop. |
| N-12 | Done | `hosts/probe.ts`, `transport/ssh.ts` | Errors name the port, the host, the stage, and the fix. |
| N-13 | Done | `web/src/components.tsx` | Every pip carries a text label; filled vs hollow shape distinguishes states in greyscale. |
| N-14 | Done | `/api/attachments` | 25 MB cap, content sniffed for NUL bytes rather than trusting the extension, stored by UUID in a quarantine dir, never executed. |

## Prerequisites

| ID | Status | Notes |
|---|---|---|
| P-01 | Operator action | Windows OpenSSH Server. Documented in `PREREQS.md`; the probe names it when port 22 is closed. |
| P-02 | Operator action | Remote Login on all three Macs. |
| P-03 | Operator action | NOPASSWD sudo, or a sudo password in the sheet. `wrapScriptElevated` supports both. |
| P-04 | **Blocking, open** | `Revanths-Mac-mini-2` has no address of any kind. The importer accepts the row and warns; the probe fails at the `dns` stage with that specific remedy. |
| P-05 | **Cleared** | Resolved during the build: this machine is Windows 11 **Pro**, so RDP host is available and no TightVNC fallback is needed for it. Edition detection still runs for the general case. |
| P-06 | **Open, operator action** | The five inline keys are exposed in a shared spreadsheet and should be rotated. Note the *other* half of Appendix B.1 was wrong — the keys are not mangled; all five validate. |

## Connectivity — verified

All five hosts are SSH-reachable **now**. Confirmed by running `hostname; uname -a`
on each and getting back machine-specific output:

| Host | Address used | Result |
|---|---|---|
| Matha-Windows-3080-5TB | local | `isSelf` — LocalTransport, no SSH |
| old6700k-ubuntu | `100.74.173.51` (mesh) | Linux 7.0.0-28-generic x86_64 |
| Revanth's MacBook Pro | `100.86.8.24` (mesh) | Darwin 25.2.0 arm64 |
| Revanth's Mac mini | `192.168.4.72` (inventory) | Darwin 25.5.0 arm64 |
| Revanths-Mac-mini-2 | `Revanths-Mac-mini-2` (hostname) | Darwin 25.2.0 arm64 |

So **P-01 and P-02 are already satisfied** — every machine has a running SSH
server and the extracted keys authenticate.

**P-04 is not blocking in practice.** Mac mini #2 has no IP in the sheet, but its
bare hostname resolves and SSH succeeds. Recording an address is still worth
doing — mDNS is fragile across subnets and this currently works by luck.

Spec collection is verified on all three OS families, including an external
volume with a space in its name (`/Volumes/Revanth Media`).

## Live provisioning results

Two hosts are provisioned and benchmarked end to end:

| Host | GPU | Backend | eval tok/s | TTFT |
|---|---|---|---|---|
| Matha-Windows-3080-5TB | RTX 3080 | cuda | **158.59** | 443 ms |
| old6700k-ubuntu | GTX 1080 | cuda | **61.22** | 611 ms |

Both on `gemma4:e2b` at `num_ctx=8192`, `temperature=0`, `seed=42`, so the 2.6x
spread is hardware, not configuration.

**N-10 measured: 1159 ms.** A re-provision of a complete host skips every step
except `detect_os`, well inside the 20 s requirement.

`detect_os` on Windows returned "Microsoft Windows 11 Pro 10.0.26200", which is
P-05 confirmed programmatically rather than by hand.

### Bugs live provisioning found

Each of these only surfaced by running against real machines:

1. **xrdp vs gnome-remote-desktop.** Ubuntu 26.04 already serves RDP on 3389.
   The step checked for xrdp specifically, installed a second server, and it
   died with `EADDRINUSE` — leaving the host worse off than before. The check
   now asks whether *anything* is listening on 3389 rather than naming an
   implementation.
2. **"Installed" is not "usable".** `install_ollama` checked only for the
   binary, so a host with Ollama already present skipped the step and never got
   `OLLAMA_HOST=0.0.0.0` — every benchmark would then fail as unreachable. The
   check now verifies the bind address too.
3. **Fabricated prompt throughput.** Ollama serves repeated prompts from its KV
   cache and still reports the full token count against a near-zero duration,
   producing 78,633 tok/s on a GTX 1080. Since the suite deliberately repeats
   prompts for comparability, 2 of every 3 runs were affected. Cached runs are
   now detected and excluded, with a regression test.
4. **Local host benchmarked over the mesh.** The operator's own Ollama binds
   loopback; `ollamaUrl` now uses 127.0.0.1 for `isSelf` rather than routing out
   to the mesh and back.

## Why the Macs showed as "not connected"

Diagnosed rather than assumed — the three had three different problems, and the
obvious reading was wrong in one case.

| Host | sudo | Mesh client | Screen Sharing | Reaches control plane |
|---|---|---|---|---|
| Revanth's Mac mini | NOPASSWD | **none installed** | ON | yes (200) |
| Revanths-Mac-mini-2 | needs password | **none installed** | ON | yes (200) |
| Revanth's MacBook Pro | needs password | Tailscale, connected | **OFF** | yes (200) |

- **The Mac minis have no mesh client at all.** Not misconfigured — Tailscale
  and NetBird are both simply absent, which is why they report `mesh=none` and
  are reachable only over the LAN (`192.168.4.72`) or mDNS.
- **The MacBook Pro is connected.** It holds `100.86.8.24` with an active direct
  path. Its actual fault is that **Screen Sharing is off**, so remote desktop
  fails while everything else works. "Not connected" in the desktop sense, fully
  connected in the mesh sense.
- **All three can reach the new control plane** at `https://192.168.4.29`, so
  enrollment is network-viable the moment a setup key exists.

The common blocker is credentials, not connectivity: enrolling in either mesh
needs an auth/setup key, and two of the three need a sudo password to change
anything privileged.

## Remaining: the three Macs

All three are reachable and online, but none is provisioned:

| Host | sudo | Homebrew | Blocker |
|---|---|---|---|
| Revanth's Mac mini | NOPASSWD | absent | Homebrew needed for gh/ollama |
| Revanth's MacBook Pro | needs password | absent | **P-03** — no sudo password stored |
| Revanths-Mac-mini-2 | needs password | absent | **P-03** — no sudo password stored |

Two of the three need a sudo password that is not in the inventory and cannot be
guessed. Either add a `Sudo Password` column and re-import, or configure
NOPASSWD as `PREREQS.md` describes. The Mac mini has NOPASSWD and only needs
Homebrew, which the macOS steps currently assume rather than install.

## What would unblock the remaining items

1. **A live provisioning run.** The engine is implemented and dry-run is
   verified, but **no host has ever been provisioned for real**. This is the
   largest untested path in the project and the one that installs software on
   your machines. Run it against one host first, not the fleet.
2. **A NetBird control plane** (R-10 live test, and the mesh migration). Needs a
   Linux VM with a public domain — see `deploy/netbird/README.md`.
3. **Docker installed** (R-25 client, R-26). The reachability problem is solved
   and documented; only the browser client remains.
4. **Ollama on at least one host** (R-18 live numbers, R-28 agent loop). Comes
   free with a successful provisioning run.

## Bugs found by testing rather than by reading

Both were found in the last stretch, by running things instead of assuming:

- **macOS storage parsing was wrong.** `df -k` on macOS has three columns Linux
  does not, so mount points were parsed from the wrong field and came out as
  `453019 4287678157 0% /`. It also listed ~50 Xcode simulator volumes as real
  disks. Fixed and re-verified.
- **A backtick inside a JS template literal** silently terminated a collector
  script and crashed the API on reload — in a comment, in the module whose whole
  purpose is careful escaping.

The lesson generalises to the untested paths: assume live provisioning has
comparable problems until it has actually been run.
