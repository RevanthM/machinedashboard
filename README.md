# Fleet Console

Local-first fleet dashboard: NetBird mesh + SSH/RDP + Ollama telemetry + an
agentic LLM shell. Runs entirely on the operator's machine, bound to loopback.

## Status

**M0–M7 are implemented.** Per-requirement status, including what is verified
against real hardware versus merely written, is in
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — read that rather than assuming.

Verified live on this fleet: inventory import (5/5), mesh reconciliation, spec
and telemetry collection, dry-run provisioning, per-OS shell escaping, and the
approval gate.

Three things gate the rest, all external:

1. **No NetBird control plane yet** — needs a Linux VM with a public domain
   ([deploy/netbird/README.md](deploy/netbird/README.md)).
2. **Docker not installed** — the guacd reachability problem is *solved*
   ([deploy/guacd/README.md](deploy/guacd/README.md)); only the browser client
   remains.
3. **No host has Ollama yet** — so benchmark and agent numbers are unmeasured.

Not built: session recording (R-24, "Could"), the Guacamole browser client
(R-25/R-26), and the interactive column-remap dropdown (part of R-01).

## Quick start

```bash
cp .env.example .env
```

Set `FLEET_VAULT_PASSPHRASE` (any strong passphrase — it derives the secret
vault key via scrypt). Then:

```bash
npm install
npm run db:migrate
npm run dev
```

API on `127.0.0.1:8080`, web on `127.0.0.1:5173`.

Both bind loopback only. v1 has no authentication, so the API refuses to start
if `API_HOST` is anything else — binding wider would expose shell access to
every managed host on the local network.

## Before importing anything

Read [PREREQS.md](PREREQS.md). Fleet Console reaches machines over SSH and
cannot bootstrap one that has no SSH server running.

Then set up the mesh: [deploy/netbird/README.md](deploy/netbird/README.md).

## Verification scripts

These run against real hardware rather than fixtures, and each one caught
something during the build:

```bash
npm run shell:verify   -w @fleet/api   # executes wrapped payloads in a live shell
npm run mesh:verify    -w @fleet/api   # lists peers; reports migration-stranded hosts
npm run inventory:verify -w @fleet/api -- <file.xlsx>   # dry-run import, writes nothing
```

`inventory:verify` never prints key material — it reports only whether an inline
key is well-formed.

## Layout

```
apps/api/          Fastify + SQLite backend
  src/shell/       Per-OS command construction. The ONLY place a command line
                   is built; everything else calls wrapScript().
  src/mesh/        MeshProvider seam — NetBird (primary), Tailscale (read-only,
                   for migration), Null.
  src/transport/   SSH (ssh2, TOFU host keys) and Local (this machine).
  src/inventory/   Spreadsheet parsing and inline-key extraction.
  src/secrets/     AES-256-GCM vault.
  src/db/          Drizzle schema + migrations.
  scripts/         Live verification tools.
apps/web/          Vite + React + Tailwind dashboard
deploy/netbird/    Control plane deployment notes
```

## Security posture

| Control | Where |
|---|---|
| Loopback-only bind, enforced at startup | `apps/api/src/config.ts` |
| Secrets in AES-256-GCM vault, never in SQLite | `apps/api/src/secrets/vault.ts` |
| Host key pinning (TOFU), changes are hard failures | `apps/api/src/transport/ssh.ts` |
| Setup keys passed via env, never inlined into logged scripts | `apps/api/src/mesh/netbird.ts` |
| Inline private keys written 0600, only paths persisted | `apps/api/src/inventory/keys.ts` |

The approval gate for agent-proposed commands (PRD §F7) is **not yet built**.
Do not wire the agent loop to a transport until it is — the gate is the backstop
that makes prompt injection survivable, and it must not be bypassable by model
output.
