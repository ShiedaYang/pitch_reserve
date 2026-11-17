#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
launch_script=${1:-start-desktop.sh}
if [ "$#" -gt 0 ]; then shift; fi
case "$launch_script" in
  /*) ;;
  *) launch_script="$project_dir/$launch_script" ;;
esac

if [ "$(uname -s)" != Linux ] || [ "$(id -u)" -eq 0 ]; then
  echo 'Run this on Linux as the regular console service user.' >&2
  exit 1
fi
if [ ! -r "$launch_script" ] || ! command -v systemd-run >/dev/null 2>&1; then
  echo 'A readable launch script and systemd-run are required.' >&2
  exit 1
fi
if ! awk '{for (i=1; i<=NF; i++) if ($i == "memory") available=1} END {exit !available}' /sys/fs/cgroup/cgroup.controllers; then
  echo 'The cgroup v2 memory controller is required.' >&2
  exit 1
fi

# Size the budget from the guest's actual memory, with headroom for the OS.
total_mib=$(awk '$1 == "MemTotal:" {print int($2 / 1024); exit}' /proc/meminfo)
if [ -z "$total_mib" ] || [ "$total_mib" -lt 4 ]; then
  echo 'Cannot determine guest memory from /proc/meminfo.' >&2
  exit 1
fi
high_mib=$((total_mib * 60 / 100))
max_mib=$((total_mib * 75 / 100))

exec systemd-run --user --unit=pitch-reserve.service --collect \
  --working-directory="$project_dir" --setenv="PATH=$PATH" \
  --property=Type=exec --property=MemoryAccounting=yes \
  --property="MemoryHigh=${high_mib}M" --property="MemoryMax=${max_mib}M" \
  --property=MemorySwapMax=0 --property=OOMPolicy=kill \
  --property=KillMode=mixed --property=TimeoutStopSec=60s \
  --property=Restart=on-failure --property=RestartSec=30s \
  --property=StartLimitIntervalSec=300s --property=StartLimitBurst=3 \
  --property=RestartPreventExitStatus=78 \
  /bin/sh "$project_dir/scripts/require-memory-boundary.sh" \
  "$((high_mib * 1048576))" "$((max_mib * 1048576))" "$launch_script" "$@"
