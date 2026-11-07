/**
 * Python run on each box over one long-lived SSH connection (`python3 -u -`, script on stdin).
 * Prints one JSON line of facts first, then one line of raw counters every INTERVAL seconds;
 * rates and percentages are derived on the SparkMan host (sampler.ts), so the box does no state.
 * Only reads /proc, /sys and nvidia-smi — nothing here changes the box.
 */
export const SAMPLER_INTERVAL_S = 2

export const SAMPLER_SCRIPT = String.raw`
import glob, json, os, re, subprocess, sys, time

def rd(p):
    try:
        with open(p) as f:
            return f.read()
    except Exception:
        return None

def sh(args, timeout=5):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return None

GPU_Q = ('utilization.gpu,power.draw,temperature.gpu,clocks.sm,clocks.max.sm,'
         'clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown,'
         'clocks_event_reasons.hw_slowdown,clocks_event_reasons.sw_power_cap')

def driver_of(iface):
    try:
        return os.path.basename(os.readlink('/sys/class/net/%s/device/driver' % iface))
    except Exception:
        return None

def default_iface():
    for line in (rd('/proc/net/route') or '').splitlines()[1:]:
        f = line.split()
        if len(f) > 2 and f[1] == '00000000':
            return f[0]
    return None

smi = sh(['nvidia-smi']) or ''
m = re.search(r'CUDA Version:\s*([0-9.]+)', smi)
facts = {
    'facts': {
        'cpus': os.cpu_count(),
        'kernel': os.uname().release,
        'driver': sh(['nvidia-smi', '--query-gpu=driver_version', '--format=csv,noheader']) or '',
        'cuda': m.group(1) if m else '',
        'cx7': sorted(i for i in os.listdir('/sys/class/net') if driver_of(i) == 'mlx5_core'),
        'mgmt': default_iface(),
    }
}
IFACES = [i for i in [facts['facts']['mgmt']] + facts['facts']['cx7'] if i]
facts['facts']['macs'] = {i: (rd('/sys/class/net/%s/address' % i) or '').strip() for i in IFACES}
print(json.dumps(facts), flush=True)
CX7 = facts['facts']['cx7']

def rdma_counters(iface):
    # RoCE bypasses the kernel, so /proc/net/dev never sees it: the port's own counters do (4-byte units)
    try:
        dev = sorted(os.listdir('/sys/class/net/%s/device/infiniband' % iface))[0]
        return '/sys/class/infiniband/%s/ports/1/counters/' % dev
    except Exception:
        return None
RDMA = {i: p for i, p in ((i, rdma_counters(i)) for i in CX7) if p}

zones = sorted(glob.glob('/sys/class/thermal/thermal_zone*/temp'))
hwmon = {}
for d in glob.glob('/sys/class/hwmon/hwmon*'):
    name = (rd(d + '/name') or '').strip()
    hwmon.setdefault(name, []).extend(sorted(glob.glob(d + '/temp*_input')))
WHOLE_DISK = re.compile(r'^nvme\d+n\d+$')

def num(p):
    try:
        return int((rd(p) or '').strip())
    except Exception:
        return None

while True:
    s = {'t': time.time()}
    stat = (rd('/proc/stat') or '').split('\n', 1)[0].split()[1:9]
    s['cpu'] = [int(x) for x in stat]
    mem = {}
    for line in (rd('/proc/meminfo') or '').splitlines():
        k, _, v = line.partition(':')
        if k in ('MemTotal', 'MemAvailable'):
            mem[k] = int(v.split()[0])
    s['mem'] = mem
    s['gpu'] = sh(['nvidia-smi', '--query-gpu=' + GPU_Q, '--format=csv,noheader,nounits'])
    s['acpi'] = [v for v in (num(z) for z in zones) if v is not None]
    s['hwmon'] = {k: [v for v in (num(p) for p in ps) if v is not None] for k, ps in hwmon.items()}
    net = {}
    for line in (rd('/proc/net/dev') or '').splitlines()[2:]:
        name, _, rest = line.partition(':')
        f = rest.split()
        if len(f) >= 9:
            net[name.strip()] = [int(f[0]), int(f[8])]
    s['net'] = net
    disk = {}
    for line in (rd('/proc/diskstats') or '').splitlines():
        f = line.split()
        if len(f) > 9 and WHOLE_DISK.match(f[2]):
            disk[f[2]] = [int(f[5]), int(f[9])]
    s['disk'] = disk
    v = os.statvfs('/')
    s['fs'] = [v.f_blocks * v.f_frsize, (v.f_blocks - v.f_bfree) * v.f_frsize]
    s['links'] = {i: (rd('/sys/class/net/%s/operstate' % i) or '').strip() for i in CX7}
    s['rdma'] = {i: [num(p + 'port_rcv_data'), num(p + 'port_xmit_data')] for i, p in RDMA.items()}
    s['ifaces'] = {i: [(rd('/sys/class/net/%s/operstate' % i) or '').strip(), num('/sys/class/net/%s/speed' % i), num('/sys/class/net/%s/mtu' % i)] for i in IFACES}
    s['up'] = float((rd('/proc/uptime') or '0').split()[0])
    print(json.dumps(s), flush=True)
    time.sleep(${SAMPLER_INTERVAL_S})
`
