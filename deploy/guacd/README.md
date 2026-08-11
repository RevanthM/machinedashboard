# Remote desktop (guacd)

## Which deployment to use

There are two compose files, and the choice is not cosmetic — it decides
whether the loopback shim is needed at all.

| File | For | Shim needed? |
|---|---|---|
| `docker-compose.linux.yml` | A **Linux** host that is itself a mesh member | **No** |
| `docker-compose.yml` | Docker Desktop on Windows/macOS | Yes |

**Prefer the Linux one.** On Linux, `network_mode: host` gives the container the
host's real interfaces including its mesh adapter, so guacd dials `100.x.x.x`
directly. This was verified on `old6700k-ubuntu`: from inside that host,
`100.68.217.73:3389` (the Windows box's RDP, over the mesh) is reachable.

That is the clean resolution to PRD §14 risk #1. The shim exists only because
Windows cannot do this — see below.

### Deployed configuration for this fleet

guacd runs on `old6700k-ubuntu`, which is Linux, always-on, and already a mesh
peer:

```bash
docker compose -f deploy/guacd/docker-compose.linux.yml up -d
```

Operator `.env`:

```ini
GUACD_HOST=100.74.173.51   # reach guacd over the mesh, not the LAN
GUACD_PORT=4822
```

Note the mesh address rather than `192.168.4.29`: that host runs `ufw`, which
blocks 4822 on the LAN interface while the mesh path works. Using the mesh
address also means the operator laptop does not need to be on the same subnet.

**Do not expose 4822 beyond the mesh.** Anything that can reach guacd can ask it
to connect anywhere — it performs no authentication of its own.

## Windows / Docker Desktop fallback

```bash
docker compose -f deploy/guacd/docker-compose.yml up -d
```

Then check the preflight for a host — it reports whether guacd is answering and
whether the host's desktop port is reachable, before you open a session that
would otherwise just hang:

```bash
curl -s http://127.0.0.1:8080/api/hosts/<id>/rdp/preflight
```

## Why there is no mesh client in this container

PRD §14 lists "guacd cannot reach mesh IPs from inside Docker" as the project's
#1 integration risk, and says to prove it before building any UI. It was proven
unworkable on this operator machine, for a structural reason:

- The operator runs **Windows 11 Pro**. Docker Desktop containers execute inside
  a WSL2 VM.
- `network_mode: host` is Linux-only — on Windows it does not give a container
  the host's interfaces.
- The mesh client's TUN adapter belongs to the **Windows** host, not the WSL2
  VM, so `100.64.0.0/10` is not routable from inside a container regardless of
  compose settings.

So rather than trying to give guacd mesh access, Fleet Console removes its need
for it. Per session:

1. The API (running natively on Windows, with mesh access) opens a TCP listener
   on `127.0.0.1:0` — the OS assigns a free port.
2. That listener proxies bytes to the host's real mesh address, e.g.
   `100.86.8.24:5900`.
3. The connection token handed to guacd points at
   `host.docker.internal:<that port>`.
4. guacd connects to the Docker host. It never sees a mesh address.

The shim is **single-use** (it stops accepting after the first connection) and
self-closing (60s to be claimed, then a session cap). A listener left open would
be an unauthenticated tunnel to a host's RDP port sitting on loopback.

This also works unchanged on Linux and macOS operators, so there is one code
path rather than a per-platform branch.

## Per-OS protocol

| OS | Protocol | Server | Notes |
|---|---|---|---|
| macOS | VNC :5900 | Screen Sharing (built in) | Majority of this fleet — 3 of 5 |
| Windows Pro/Ent | RDP :3389 | Built in | Enabled during provisioning |
| Windows Home | VNC :5900 | TightVNC | Home has no RDP host; edition detected at `detect_os` |
| Ubuntu/Debian | RDP :3389 | xrdp | Installed during provisioning |

Credentials never reach the browser. The API mints a 60-second, single-use,
AES-GCM-sealed token bound to the host id; the browser holds only that.
