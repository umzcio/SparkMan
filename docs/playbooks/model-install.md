# Playbook: install and serve a model on the fleet

For an AI agent (or a person) asked to "put model X on the fleet". It is the order of operations that has
worked, with a check after every step and the failures that actually happened. Follow it top to bottom; don't
skip a check because the previous step "obviously" worked.

## 0. Before anything

1. **Read the site file**: `/etc/sparkman/site-notes.md` on the SparkMan host. It names the hosts, the models
   library, which nodes form which group, the fabric addresses and where credentials live. This playbook uses
   placeholders: `<library>` (the library host), `<head>` (rank 0 / the launcher's first node), `<worker-N>`,
   `<fabric-ip>`.
2. **Ground rules.** Ask the operator before you: install system packages, use sudo for anything not listed in
   this playbook's prerequisites, reboot, or stop a container or model you didn't start. Never delete model
   weights or anyone's data. Keep the model's API on the private networks (fleet LAN, fabric, tailnet), never the
   internet. Don't run benchmarks or test suites without an explicit go. Never print a secret: when a command
   carries one, don't echo its output.
3. **Is the hardware free?** In SparkMan: Deployments (every launcher's state) and each target node's memory.
   A multi-node model needs every node of its group free. Check what you'd displace and say so before you stop
   anything.
4. **Pick a served model name** that no other launcher uses (a second launcher serving the same name makes the
   gateway route one name to two servers). Use the recipe's `SERVED_NAME` (or equivalent) to make it unique.

## 1. The recipe

1. Clone it on `<head>` into its own folder (e.g. `~/<model>-<nodes>x`) and **pin the commit** (`git checkout <sha>`);
   note the sha for the report.
2. Read the README end to end, especially its *troubleshooting* notes and its config file (often `scripts/config.sh`):
   - every pinned revision (`MODEL_REVISION`, overlay / sidecar revisions) and file it downloads;
   - which variant flags exist (quantization, abliteration) and which are mutually exclusive;
   - its network assumptions (switch vs direct cables, NFS export layout, `MASTER_ADDR`, fabric addresses);
   - how it reports "ready" (the log line and the smoke test), so you can watch for it.
3. Write the recipe's local settings file (e.g. `scripts/local.sh`) from its example. Use **fabric** addresses for
   workers and set `MASTER_ADDR` to `<head>`'s fabric address, or rendezvous may go over the tailnet.

## 2. Download once, into the library

Never let a recipe download a checkpoint on a GPU node over the site's internet uplink. The library host has the bandwidth,
the disk, and the Hugging Face login.

1. On `<library>`, write a small script beside the library (`dl-<model>.sh`) that runs
   `hf download <repo> --revision <pinned sha> --cache-dir <library>/<Family>/hub` for every repo the recipe pins
   (include `--include <file>` for sidecars). Log to `<library>/logs/dl-<model>.log`, ending in `ALL DONE` or `FAILED`.
2. Run it detached: `nohup setsid ./dl-<model>.sh > logs/dl-<model>.log 2>&1 < /dev/null &`.
3. **Gated repos** need the operator's login even after access is granted. If `hf` says gated / 401, ask the
   operator to run `hf auth login` on `<library>` themselves (it's interactive), then retry.
4. **Watch it to the end** (see §6 for watchers). Then verify:
   `hf cache verify <repo> --revision <sha> --cache-dir <library>/<Family>/hub --fail-on-missing-files` — it must say
   every checksum matches.
5. Record it: a row in the library's `INDEX.md` and a `.copied` note in the repo folder (source, revision, date,
   file count and bytes, "verified").

## 3. Copy to the head

1. **Check the head's cache is yours**: `ls -ld ~/.cache/huggingface/hub`. A root-owned cache (left by an earlier
   root download) makes the copy fail with "Permission denied"; `sudo chown -R <user>: ~/.cache/huggingface/hub`
   (it's the user's own folder) and say so in the report.
2. Make the snapshot folder and its ref, then copy **through the symlinks** — `hf` 2.x keeps the big files in a
   blob store the snapshot links into:
   ```
   mkdir -p ~/.cache/huggingface/hub/models--<org>--<name>/{snapshots/<sha>,refs}
   echo -n <sha> > ~/.cache/huggingface/hub/models--<org>--<name>/refs/main
   rsync -aL --partial <library-mount>/<Family>/hub/models--<org>--<name>/snapshots/<sha>/ \
     <head>:.cache/huggingface/hub/models--<org>--<name>/snapshots/<sha>/
   ```
3. **Check**: same file count and same total bytes on both sides
   (`find -L <snapshot> -type f | wc -l` and `du -sbL <snapshot>`). With the snapshot present at the pinned revision,
   the recipe's own `hf download` finds it and downloads nothing (it may still ask the Hub for metadata; a public
   repo needs no token for that).

## 4. Multi-node prerequisites

Check each one; fix only what's missing (all of these are recipe prerequisites the operator has agreed to when they
asked for a multi-node model, but still list every change in the report).

| Check | Command (on each node unless noted) | Fix |
|---|---|---|
| Docker without sudo | `docker ps` | add the user to `docker` (`sudo usermod -aG docker <user>`; new SSH sessions pick it up) |
| GPU in containers | `docker run --rm --gpus all ubuntu:24.04 nvidia-smi -L` | needs nvidia-container-toolkit: ask |
| Head → worker SSH by key, over the fabric | on `<head>`: `ssh -o BatchMode=yes <user>@<worker-fabric-ip> hostname` | the operator adds `<head>`'s public key to the worker's `authorized_keys` |
| Firewall allows the fabric | `sudo ufw status \| grep -i cx7` | allow in on each fabric netdev from its subnet (match the other nodes' rules) |
| Fabric links up | `cat /sys/class/net/<cx7-if>/operstate /sys/class/net/<cx7-if>/speed` | cabling — see the warning below |
| MTU and RDMA MTU | `cat /sys/class/net/<cx7-if>/mtu` (9000); `ibv_devinfo \| grep active_mtu` (4096) | the NM profile's `802-3-ethernet.mtu`, then `nmcli con up` (reapply doesn't change MTU) |
| Lossless fabric | `dcb pfc show dev <cx7-if> prio-pfc` (the class the switch uses on) | the site's PFC hook (see the site file) |
| Fabric addresses | `ip -br -4 addr \| grep np` | the node's NM profile per netdev |
| RDMA works across | `rping` or `ucx_perftest` between two nodes (perftest versions differ between nodes, see the site file) | — |

**Never plug or unplug a ConnectX-7 cable on a running node.** The card is re-enumerated on cable plug-in, and
any firmware tool touching it then (a temperature collector, an `mstflint` query) can crash the kernel; the box
hangs and needs a power cycle. If a node needs its cable changed: shut it down, cable, boot.

**NFS** (recipes where the head shares its HF cache with the workers): the export and the recipe must agree on
the path. If the export's NFSv4 root (`fsid=0`) *is* the cache folder, the path workers mount is `/` — set the
recipe's `NFS_PATH=/`. Export read-only, to the workers' fabric addresses only. Test from a worker:
`sudo mount -t nfs4 -o ro <head-fabric-ip>:/ /mnt && ls /mnt && sudo umount /mnt`. A docker volume made with the
wrong path must be removed (`docker volume rm <name>`) before the recipe re-creates it.

## 5. First start

1. Start it through a **wrapper script** in the recipe folder (e.g. `sparkman-start.sh`) that sets what a
   non-interactive SSH session lacks — at least `export PATH=$HOME/.local/bin:$PATH` (where `hf` is installed) —
   then `exec ./start.sh "$@"`. SparkMan's launcher will run the same wrapper.
2. Run it detached with a log: `nohup setsid ./sparkman-start.sh > runs/first-start.log 2>&1 < /dev/null &`.
3. Watch it to the end (§6). A first start typically: builds the engine image (minutes), copies it to the workers,
   finds the checkpoint, builds kernels/kits, bakes per-node weight files (minutes each), copies per-worker data
   over the fabric (~1 GB/s), loads, and runs its smoke test. Expect an hour or more.
4. **When it stops**: read the log's last error and the recipe's troubleshooting section *before* changing
   anything. Fix the cause, then re-run — recipes like this skip finished steps.

| Seen | Cause | Fix |
|---|---|---|
| `the Hugging Face CLI ('hf') is not installed` | `~/.local/bin` not on PATH in a non-interactive shell | start through the wrapper |
| `cannot mount … over NFS … no such file or directory` | export root vs `NFS_PATH` mismatch | §4 NFS |
| `permission denied … docker.sock` on a worker | user not in `docker` | §4 |
| `Permission denied (publickey)` head → worker | head's key not on the worker | §4 |
| a worker load crawls | its path to the head (NFS over a slow hop) | the recipe's README; fabric addresses |
| `port … already in use` | another model on that port | stop it (ask first if you didn't start it) |

## 6. Watching long jobs

- Poll a log for the recipe's stage lines and exit on success, error, or the process ending. Report when it ends;
  don't wait to be asked.
- **A watcher must not match itself**: `pgrep -f "start.sh"` run inside `ssh host '…'` finds the SSH command's own
  shell (its command line contains the pattern) and reports "running" forever. Use a bracket pattern:
  `pgrep -f "[b]ash ./start.sh"`.
- Make the watcher exit on `ERROR`, not only on exit.

## 7. Register it in SparkMan

SparkMan's settings for a model (context window, capabilities, max output) apply only to a launcher SparkMan
started itself; a server started by hand shows up as "discovered" with no capabilities and a 128k fallback context.

1. Create the launcher (Deployments → Launchers, or `POST /api/fleet/launchers` with `content-type: application/json`):
   `name`, `nodeIds` (head first, every node it occupies), `dir`, `startScript` (the wrapper), `stopScript`
   (the recipe's stop), `port`, `sudo` (false unless the scripts need root), `caps` (`tools`, `thinking`, `images`),
   `maxOutput`, `contextWindow`, `notes` (recipe, commit, revision, layout).
2. Stop the hand-started server (the recipe's `stop.sh`), then start the model **from the launcher**. Check the
   deployment shows the right context and capabilities and that the gateway routes its served name.
3. Restarting SparkMan for any reason: restart `sparkman` only. `sparkman-gateway` carries clients' in-flight
   requests; restarting it cuts them off.

## 8. Verify and report

1. The recipe's smoke test passed (its own "OK" line) and `GET http://<head>:<port>/v1/models` lists the served name.
2. One request through the gateway with a real API key succeeds.
3. Benchmarks only with the operator's go (SparkMan's Benchmarks page runs decode / prefill / quality).
4. **Report**: what's serving (name, nodes, context, variant, recipe commit, checkpoint revision), every change you
   made (files, configs, packages, groups, firewall, exports, permissions, keys), where the logs are, how to
   stop/start it (the launcher), anything left undone or risky.
