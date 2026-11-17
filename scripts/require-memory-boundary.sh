#!/bin/sh
set -eu

bounds_error() {
  echo 'Pitch Reserve did not start. Its cgroup memory limits or group OOM policy are missing.' >&2
  exit 78
}

expected_high=$1
expected_max=$2
shift 2
group=$(awk 'sub(/^0::/, "") {print; exit}' /proc/self/cgroup)
case "$group" in
  /*/pitch-reserve.service) ;;
  *) bounds_error ;;
esac
group_dir="/sys/fs/cgroup$group"

check_value() {
  IFS= read -r value < "$group_dir/$1" || bounds_error
  [ "$value" = "$2" ] || bounds_error
}

check_value memory.high "$expected_high"
check_value memory.max "$expected_max"
check_value memory.swap.max 0
check_value memory.oom.group 1
printf 'Pitch Reserve cgroup ready. MemoryHigh=%s bytes, MemoryMax=%s bytes.\n' "$expected_high" "$expected_max"
exec /bin/sh "$@"
