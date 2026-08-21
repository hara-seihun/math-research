# The software-engineering skill requires a test pipeline to finish in under a
# minute, so the pipeline enforces it on itself: a suite that wants longer is a
# suite to rewrite, not a limit to raise. The usual cause is waiting on a clock
# instead of on the state you actually need — this one spent 56 of its 80
# seconds in `sleep 0.1`, which was hiding a five second wake-up gap in the
# verifier that every real submission was paying too.
#
# Sourced by a test that has already cd'd to the repository root, which then
# re-executes itself under the deadline. `timeout --foreground` so an
# interactive run stays interruptible, and INT rather than TERM so the suite's
# own cleanup trap still runs.
if [[ -z ${UNDER_A_MINUTE:-} ]]; then
  # $0 is unreliable after a cd, so the caller is located next to this file.
  under_a_minute_caller="$(dirname "${BASH_SOURCE[0]}")/$(basename "${BASH_SOURCE[1]}")"
  [[ -x $under_a_minute_caller ]] || {
    echo "under-a-minute.sh: cannot find the test that sourced it ($under_a_minute_caller)" >&2
    exit 1
  }
  export UNDER_A_MINUTE=60
  exec timeout --foreground --signal=INT --kill-after=5 "$UNDER_A_MINUTE" "$under_a_minute_caller" "$@"
fi
