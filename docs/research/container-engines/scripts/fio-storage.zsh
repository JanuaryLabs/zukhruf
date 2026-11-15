#!/usr/bin/env zsh
# Experiment 5, fio-storage: throughput of fio random writes and reads at 4k and 1m blocks on three
# storage targets: a bind mount of a host folder, a named volume, and the container root filesystem.
#
# One container per slot (--cpus 2 --memory 1g) holds all three targets and runs each fio job
# with docker exec, so container start-up is outside every measurement. Per target and block size,
# randwrite runs first (fio lays the file out before it times anything) and randread then reads
# that file and deletes it (--unlink=1). --ramp_time is the warm-up of each job.

BENCH_USAGE="usage: fio-storage.zsh [options] [--runtime SECONDS]

Runs fio randwrite and randread, bs 4k and 1m, size 256M, direct=1, libaio iodepth 32,
time-based (--runtime, default 20 s, after a 2 s ramp), on /mnt/bind (a host folder under the
run folder), /mnt/volume (a named volume) and /var/tmp (the root filesystem)."

source "${0:A:h}/lib.zsh"
typeset -a opt_runtime=()
zparseopts -D -E -- -runtime:=opt_runtime
runtime=${opt_runtime[-1]:-20}
bench_require_positive "--runtime takes whole seconds" $runtime
# A job lays out 256M, ramps 2 s and runs; give each exec room beyond that.
BENCH_CALL_TIMEOUT=$(( runtime + 300 ))
bench_parse_args "$@"
bench_init fio-storage
BENCH_NOTES+=(
  "fio --size=256M --direct=1 --ioengine=libaio --iodepth=32 --time_based --runtime=$runtime --ramp_time=2"
  "direct=1 bypasses the guest page cache only; on a bind mount the host may still cache the file (virtiofs on both engines)"
  "the root filesystem target is /var/tmp: overlayfs on Docker Desktop, the container's ext4 block device on Apple"
  "the named volume is ext4 on a block device on both engines"
)

typeset -A target_dir=(bind /mnt/bind volume /mnt/volume rootfs /var/tmp)
targets=(bind volume rootfs)
sizes=(4k 1m)

fio_job() {
  local engine=$1 container=$2 slot=$3 target=$4 bs=$5 rw=$6
  local file=$target_dir[$target]/zukhruf-bench-fio-$bs.dat
  local -a extra=()
  [[ $rw == randread ]] && extra=(--unlink=1)
  bench_capture "$BENCH_OUT/$slot-$target-$rw-$bs.json" \
    dk $engine exec $container fio --name=$target-$rw-$bs --filename=$file \
    --size=256M --bs=$bs --rw=$rw --direct=1 --ioengine=libaio --iodepth=32 \
    --time_based --runtime=$runtime --ramp_time=2 $extra --output-format=json ||
    print -u2 -- "warning: fio $target $rw $bs failed on $engine (exit $?); its output is kept"
}

measure_slot() {
  local engine=$1 slot=$2 target bs
  local bind=$BENCH_OUT/bind-$slot
  local volume=$BENCH_NAME_PREFIX-fio-$slot
  local container=$BENCH_NAME_PREFIX-fio-$slot
  (( BENCH_DRY_RUN )) || mkdir -p -- "$bind"
  bench_run dk $engine volume create --label $BENCH_LABEL $volume >/dev/null
  bench_run dk $engine run -d --name $container $BENCH_LIMITS \
    -v "$bind:/mnt/bind" -v "$volume:/mnt/volume" \
    $IMAGE_FIO sleep infinity >/dev/null
  for target in $targets; do
    for bs in $sizes; do
      fio_job $engine $container $slot $target $bs randwrite
      fio_job $engine $container $slot $target $bs randread
    done
  done
  bench_run dk $engine rm -f -v $container >/dev/null
  bench_run dk $engine volume rm $volume >/dev/null
  # fio deleted its files (--unlink=1 on the read); the bind folder is empty unless a job failed.
  (( BENCH_DRY_RUN )) || rmdir -- "$bind" 2>/dev/null ||
    print -u2 -- "warning: $bind still holds fio files from a failed job"
}

bench_each_slot measure_slot
