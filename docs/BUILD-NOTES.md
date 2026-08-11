# Build notes

What was verified against the real fleet, and where the implementation departs
from the PRD. Each departure is a finding from the machine, not a preference.

## Findings that changed the design

### The operator laptop is fleet host #1

`MATHA-WINDOWS-3` — Ryzen 9 5950X, RTX 3080, 63.9 GB, Windows 11 **Pro** — is
`Matha-Windows-3080-5TB` from Appendix A. The PRD models all five machines as
remote SSH targets; one of them is localhost.

Consequences:

- Added `LocalTransport` alongside `SshTransport` behind a `Transport`
  interface. The importer sets `isSelf` by matching the inventory hostname
  against the local one, and everything above the seam is unaware.
- The browser terminal is unavailable for this host: a real PTY needs
  `node-pty`, a native module, and this machine has no compiler toolchain. It
  fails with an explicit reason rather than half-working.
- Appendix D risk #3 ("Windows edition unknown — if #1 is Home, RDP is
  unavailable") is **resolved**: it is Pro, so RDP works. Edition detection is
  still implemented for the general case.

### Appendix B.1's key-mangling premise does not hold for this file

B.1 states Excel collapsed the PEM newlines into double-spaces and prescribes a
re-wrap-at-70 repair pass. The actual workbook's five keys carry **6–7 real
newlines and zero double-spaces**, and all five parse as well-formed OPENSSH
keys.

`repairPemBody` was therefore written to *normalise whatever it is handed* and
be a no-op on correct input, rather than to assume one specific corruption. It
still repairs the double-space case (tested), plus CRLF and tab variants.

The other half of B.1 stands unchanged: the keys lived unencrypted in a shared
spreadsheet and should be rotated. The importer cannot do that.

### Three of five machines were already on Tailscale, not two

Appendix A lists the MacBook Pro as having no mesh address. It has one —
`100.86.8.24` — and was online. Live state at build time:

| Host | Mesh IP | Online |
|---|---|---|
| matha-windows-3080 | `100.68.217.73` | yes |
| old6700k-ubuntu | `100.74.173.51` | yes |
| Revanth's MacBook Pro | `100.86.8.24` | yes |

Only the two Mac minis are un-enrolled, and `Revanths-Mac-mini-2` has no address
of any kind in the inventory.

This is why `/api/mesh/migration` exists. Both NetBird and Tailscale allocate
from `100.64.0.0/10`, so a host carried only by Tailscale is stranded the moment
Tailscale is removed — and the Ubuntu box and MacBook are on `192.168.4.x` while
the operator laptop is on `192.168.5.238`, so there is no LAN fallback. The
endpoint names exactly which hosts are not yet safe to cut over, and the
dashboard leads with it.

### Host #1 has three different names, and none of them match

Discovered when mesh reconciliation left the local machine showing
`mesh: unknown` despite being plainly connected:

| Source | Name |
|---|---|
| Inventory `Hostname` column | `Matha-Windows-3080-5TB` |
| The OS itself | `MATHA-WINDOWS-3` |
| The tailnet | `matha-windows-3080` |

No normalisation reconciles those, and loosening the match to a prefix or fuzzy
comparison would risk binding `Revanths-Mac-mini` to `Revanths-Mac-mini-2` —
pointing a terminal or RDP session at the wrong machine.

Fixed by adding an optional `getSelfPeer()` to `MeshProvider`. The provider
knows which peer is local (`tailscale status --json` reports it as `Self`) and
says so directly, rather than anyone guessing from a string. Name matching
remains the fallback for providers that cannot answer, and `matchPeerToHost`
gained an `aliases` parameter for callers holding ground truth.

The general lesson: the inventory's hostname column is a human label. Treat it
as a hint, never as identity.

### NetBird self-hosting has requirements the PRD does not mention

Per the upstream quickstart: a **Linux** VM, a **public domain** resolving to
its public IP, and **TCP 80/443 + UDP 3478** reachable from the internet
(Traefik needs 80 for the Let's Encrypt HTTP-01 challenge).

That rules out both convenient options — this Windows laptop, and any LAN-only
address. See `deploy/netbird/README.md`. The management URL is configuration, so
nothing in the app changes when you decide where it lives.

The PRD's "embedded Dex IdP" is **correct and current**; no external IdP needed.

## Bugs caught by live verification

### PowerShell destroyed non-ASCII output

Unit tests proved `-EncodedCommand` round-trips UTF-16LE correctly. Running the
same payloads against a real `powershell.exe` showed output coming back as
`caf? ?ber ??? ??` — PowerShell writes stdout in the console code page, and
anything outside it is replaced with literal `?` **before** we receive it. No
decoding on our end recovers it.

This would have silently corrupted `Get-CimInstance` output for non-ASCII disk
and GPU names, any path under a non-ASCII user profile, and every file the agent
reads back. Fixed by prepending a UTF-8 output-encoding preamble to every
Windows payload (`WINDOWS_UTF8_PREAMBLE`), with a regression test.

The lesson generalises: `npm run shell:verify` should be run on each OS family
you manage. Encoding round-trips are not the same as shell acceptance.

### `.env` loading raced module evaluation

`config.ts` snapshots `process.env` at module-evaluation time. Loading the env
file inline at the top of `index.ts` does not work — static imports are hoisted
and evaluated first, so `db/client.ts` pulled in `config.ts` before the load
call ran. Moved to `src/env.ts`, imported first, which works because ES modules
evaluate imports in declaration order.

## Dependency deviations

| PRD | Built | Why |
|---|---|---|
| `keytar` for OS keychain | AES-256-GCM file vault | `keytar` was archived in 2023, is an unmaintained native dependency, and needs a compiler toolchain this machine lacks. The `SecretVault` interface leaves room for a keychain impl. |
| `better-sqlite3 ^11` | `^13.0.3` | v11 has no Node 24 (ABI 137) prebuild and tried to compile against a non-existent VS toolchain. v13 has the prebuild. |
| Tailwind + shadcn/ui | Tailwind v4 | v4 needs only the Vite plugin — no config file or PostCSS chain. shadcn components can still be copied in. |

## Not yet built

Milestones M2–M8. The seams are in place for each, but nothing beyond import and
mesh reconciliation runs yet.

**Do not wire the agent loop (F7) to a transport until the approval gate exists.**
It is the backstop that makes prompt injection survivable — a file that says
`curl x | sh` must still hit the gate — and it must not be bypassable by model
output.

**Do not build the F8 UI until guacd-over-mesh is proven.** PRD §14 flags this
as risk #1 and says to prototype it in M0. It is unresolved: Docker is not
installed here, and `network_mode: host` is Linux-only so it is unavailable on
this Windows operator machine. The planned mitigation is a loopback TCP shim —
Node holds the mesh connection and guacd dials `host.docker.internal:<port>`, so
guacd never needs mesh routing. `GUAC_SHIM_ADVERTISE_HOST` is already wired for
it. Prototype before building UI.
