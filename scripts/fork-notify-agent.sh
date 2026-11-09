#!/usr/bin/env bash
# Posts a failed fork workflow run to the repair agent webhook (a T3 scheduled task).
# Called by the notify_agent job of fork-ci.yml and fork-release.yml. See docs/fork/operations.md "Repair agent".
# Env: WEBHOOK_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, GH_TOKEN, NEEDS_JSON
# (the workflow's toJSON(needs)), plus the default GITHUB_* variables.
set -euo pipefail

if [[ -z "${WEBHOOK_URL:-}" ]]; then
  echo "T3_AGENT_WEBHOOK_URL is not set. No agent is notified."
  exit 0
fi

# A repair agent's push to main starts new runs that cannot pass notify_agent=false.
# So a failure right after a failure of the same workflow does not post again, when the
# notify job of that failure succeeded and that failure started less than 90 minutes before
# this run: the repair agent watches the next run and reports it. A notify job that
# failed reached no agent. Pull request runs never notify, so they do not count.
# Skipped calls also have a successful notify job, so a longer window could silence
# every failure in a chain of runs that start less than 90 minutes apart.
# Limit: a repair that takes more than 90 minutes can get another call on the next failure.
max_quiet_seconds=$((90 * 60))
previous="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$GITHUB_WORKFLOW" --status completed --limit 20 \
  --json databaseId,conclusion,event,startedAt --jq "[.[] | select(.databaseId != ${GITHUB_RUN_ID} and .event != \"pull_request\")
    | select(.conclusion != \"cancelled\" and .conclusion != \"skipped\")][0] // empty
    | \"\\(.databaseId) \\(.conclusion) \\(.startedAt)\"")"
read -r previous_id previous_conclusion previous_started <<<"$previous"
if [[ "${previous_conclusion:-}" == "failure" ]]; then
  notified="$(gh run view "$previous_id" --repo "$GITHUB_REPOSITORY" --json jobs \
    --jq '[.jobs[] | select(.name == "Notify repair agent")][0].conclusion // empty')"
  this_started="$(gh run view "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --json startedAt --jq .startedAt)"
  # Separate assignments, so that set -e stops the script when a time does not parse.
  this_epoch="$(date -d "$this_started" +%s)"
  previous_epoch="$(date -d "$previous_started" +%s)"
  gap_seconds=$((this_epoch - previous_epoch))
  if [[ "$notified" == "success" ]] && (( gap_seconds < max_quiet_seconds )); then
    echo "The previous ${GITHUB_WORKFLOW} run failed ${gap_seconds} s before this run, and its call succeeded. No new call."
    exit 0
  fi
  echo "The previous ${GITHUB_WORKFLOW} run failed ${gap_seconds} s before this run, and its notify job ended with '${notified:-none}'. Notifying."
fi

payload="$(jq -n \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg branch "$GITHUB_REF_NAME" \
  --arg event "$GITHUB_EVENT_NAME" \
  --arg workflow "$GITHUB_WORKFLOW" \
  --arg run_url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
  --arg run_id "$GITHUB_RUN_ID" \
  --argjson needs "$NEEDS_JSON" \
  '{repository: $repository, branch: $branch, event: $event, workflow: $workflow,
    run_url: $run_url, run_id: $run_id, jobs: ($needs | map_values(.result))}')"
echo "$payload"
# The webhook server can restart, which takes minutes. So retry once a minute for 15 minutes on
# a refused connection and 408, 429 and 5xx (curl's --retry set). The notify jobs have
# timeout-minutes: 20 to cover the last attempt (up to 120 s).
# Only 202 with a deliveryId proves that the task took the run. Cloudflare Access answers a 302
# to its login page when it refuses the service token, and T3 answers 409 for a disabled task:
# both must fail this job, because a successful notify job silences the next failure for 90 minutes.
body="$(mktemp)"
status="$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
  --retry 15 --retry-delay 60 --retry-max-time 900 --retry-connrefused --max-time 120 \
  --dump-header "$body.headers" \
  -X POST "$WEBHOOK_URL" \
  -H "content-type: application/json" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  --data-binary "$payload")"
delivery_id="$(jq -r '.deliveryId // empty' "$body" 2>/dev/null || true)"
if [[ "$status" == "202" && -n "$delivery_id" ]]; then
  echo "The repair agent took the run: delivery ${delivery_id}."
  exit 0
fi
# The header is optional, and under pipefail a grep with no match must not end the script here.
location="$(grep -i '^location:' "$body.headers" | head -1 | tr -d '\r' | cut -d' ' -f2- || true)"
echo "::error title=Repair agent not notified::The webhook answered ${status}, not 202 with a deliveryId."
if [[ "$status" == 3* ]]; then
  echo "Redirect to ${location%%\?*}: Cloudflare Access refused the service token. Check that the repository secrets CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET hold a kitshn device token whose actor reaches the machine's T3 card."
elif [[ "$status" == "409" ]]; then
  echo "The task is disabled on the T3 server. Enable the scheduled task \"Fork repair\" there."
fi
echo "Answer body (first 300 bytes):"
head -c 300 "$body"; echo
exit 1
