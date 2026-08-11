# Prerequisites

Fleet Console reaches machines over SSH. It cannot bootstrap a machine that has
no SSH server — that is the chicken-and-egg in PRD §3. Do these by hand, once
per machine, before importing.

Import validation fails with a specific reason (`port 22 closed on 10.0.4.12`)
rather than retrying silently, so if you skip a step you will be told which one.

## Ubuntu / Debian

```bash
sudo apt update && sudo apt install -y openssh-server
sudo systemctl enable --now ssh
```

The account needs sudo. Passwordless is strongly preferred — provisioning runs
non-interactively, and macOS/Linux `sudo` wants a TTY otherwise:

```bash
echo "$USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/fleet-console
sudo chmod 440 /etc/sudoers.d/fleet-console
```

Without it, set a sudo password on the host record and Fleet Console will use
`sudo -S`. That path works but is more fragile.

## Windows 10/11/Server

Run as Administrator:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

Set PowerShell as the default SSH shell. Fleet Console encodes every payload as
PowerShell (`-EncodedCommand`), so a `cmd.exe` default shell will fail:

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -PropertyType String -Force
```

**Edition matters.** Windows Home has no RDP host and will be routed to VNC
(TightVNC) during provisioning instead. Check with:

```powershell
(Get-CimInstance Win32_OperatingSystem).Caption
```

## macOS

System Settings → General → Sharing → **Remote Login** ON. Use an admin account.

For remote desktop, also enable **Screen Sharing** in the same pane. Fleet
Console connects to macOS over VNC (`:5900`) — there is no licensed RDP host on
macOS, and Screen Sharing is the built-in equivalent.

If you want provisioning to run unattended, add a NOPASSWD sudoers entry as
under Ubuntu above. macOS `sudo` requires a TTY by default, which a
non-interactive SSH exec does not have.

---

# Operator machine

The machine running Fleet Console needs:

| Requirement | Notes |
|---|---|
| **Node ≥ 20.11** | Verified on Node 24.18. `better-sqlite3` and `ssh2` install from prebuilds — no compiler toolchain needed |
| **A mesh client** | NetBird, joined to your control plane. See `deploy/netbird/README.md` |
| **Docker** | Only for `guacd` (remote desktop, F8). Everything else runs without it |
| **OpenSSH client** | `ssh-keygen` is used to validate imported private keys |

## If this machine is also a managed host

It is, in this fleet — `Matha-Windows-3080-5TB` is the operator laptop. Fleet
Console detects that during import (matching the inventory hostname against the
local one) and marks the record `isSelf`, using a local transport instead of
SSH-ing to itself. No SSH server is required on the operator machine for its own
record.

One consequence: the browser terminal is unavailable for the local host, because
a real PTY needs `node-pty`, a native module that requires a compiler toolchain.
Every other feature — provisioning, telemetry, benchmarks, the agent — works
against it normally. Use your own terminal for interactive shells on this box.
