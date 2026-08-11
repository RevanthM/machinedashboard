# NetBird control plane

Fleet Console does not vendor a NetBird compose file. The upstream installer
generates one and keeps it current; forking it here would drift and silently
break enrollment. This directory documents the deployment and the Fleet
Console-specific wiring that follows it.

## What self-hosting actually requires

Per the [upstream quickstart](https://docs.netbird.io/selfhosted/selfhosted-quickstart),
non-negotiable:

| Requirement | Why it matters here |
|---|---|
| A **Linux** VM, ≥1 CPU / 2 GB RAM | The installer is bash and the stack is Linux containers |
| A **public domain** resolving to the VM's public IP | Dex and the dashboard issue OIDC redirects against it |
| **TCP 80 + 443** reachable from the internet | Traefik completes the Let's Encrypt HTTP-01 challenge |
| **UDP 3478** reachable | STUN, for peer-to-peer hole punching |

Two consequences worth being explicit about, because they rule out the
convenient options:

**This Windows laptop cannot host it via the supported path.** The installer is
a bash script producing a Linux compose stack, and the machine is `MATHA-WINDOWS-3`
— itself fleet host #1. Even setting the OS aside, a control plane on a laptop
that sleeps means peers cannot re-key or enroll while the lid is shut.

**A LAN-only deployment does not work either.** Let's Encrypt has to reach port
80 from the internet, and every peer must reach the management URL — including
the MacBook Pro when it is away from this network. An internal `192.168.4.x`
address satisfies neither.

So the control plane needs an always-on, publicly-addressable Linux host. A
$5/month VPS with an A record is the intended shape.

### The one on-prem option that works

`old6700k-ubuntu` (Ubuntu 26.04, always-on desktop, currently `100.74.173.51`)
is a viable host **if** you can point a real domain at your WAN IP and forward
80/443/3478 to it. That trades a monthly bill for a DNS record and three port
forwards, and couples your mesh's availability to your home connection. It is
a reasonable call — just a deliberate one.

Note the ordering hazard if you choose it: that box is currently reachable only
over Tailscale from this laptop (different subnets — `192.168.4.29` vs
`192.168.5.238`). Stand the control plane up **before** removing Tailscale, or
you lose the path you need to configure it.

## Install

On the chosen Linux host:

```bash
curl -fsSL https://github.com/netbirdio/netbird/releases/latest/download/getting-started.sh | bash
```

It prompts for the domain and writes `docker-compose.yml`, `config.yaml`,
`dashboard.env`, and `proxy.env`. Choose the Traefik option so TLS is handled
for you. User management is the embedded **Dex** IdP — no Auth0 or external
provider needed.

## Wiring Fleet Console to it

1. Open `https://<your-domain>` and create the first owner account.
2. **Team → your user → generate token.** The plaintext PAT is shown once and
   stored only as a hash; if you lose it you generate a new one.
3. Create a reusable setup key (Setup Keys → Add). Fleet Console uses it to
   enroll every host during provisioning.
4. Fill in `.env` at the repo root:

```ini
MESH_PROVIDER=netbird
NETBIRD_MGMT_URL=https://<your-domain>
NETBIRD_PAT=<the token from step 2>
NETBIRD_SETUP_KEY=<the key from step 3>
```

5. Confirm the API is reachable and see what the mesh looks like:

```bash
npm run mesh:verify -w @fleet/api
```

That prints NetBird peers, Tailscale peers, and — critically — the list of
hosts that would be **stranded** if Tailscale were removed right now.

6. Create the fleet group, ACL policy, and a scoped setup key:

```bash
npm run netbird:bootstrap -w @fleet/api
```

## Migration order

Both overlays hand out addresses from `100.64.0.0/10` and both install a route
for it, so a host running the two clients at once has ambiguous routing. This
fleet is mid-migration, which makes sequencing the main risk.

The rule: **a host joins NetBird and is verified before Tailscale comes off it.**
Never the reverse.

1. Stand up the control plane. Verify `mesh:verify` reports it reachable.
2. While Tailscale still works, enroll the remote hosts over it —
   `old6700k-ubuntu` (`100.74.173.51`) and the MacBook Pro (`100.86.8.24`).
   They briefly run both clients; on Linux and macOS that is tolerable for a
   short window.
3. Re-run `mesh:verify`. Each host must appear under NetBird peers and drop off
   the stranded list.
4. Remove Tailscale from those hosts.
5. **This laptop last.** It is the operator console; if its routing breaks
   mid-migration you lose access to everything else. Remove Tailscale, then
   install and join NetBird.
6. The two Mac minis are on neither overlay and need hands-on access. Note that
   `Revanths-Mac-mini-2` has no IP recorded in the inventory at all — resolve
   `Revanths-Mac-mini-2.local` over mDNS or assign it one before importing.
