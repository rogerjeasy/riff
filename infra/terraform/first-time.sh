#!/usr/bin/env bash
# One-time setup that needs an AWS administrator. After this, every push to main deploys
# automatically (see .github/workflows/deploy.yml). Safe to re-run.
#   AWS_PROFILE=wick-dev infra/terraform/first-time.sh
set -euo pipefail
# Print AWS CLI output directly instead of opening a pager that waits for the user.
export AWS_PAGER=""
: "${AWS_PROFILE:?set AWS_PROFILE to the administrator profile, e.g. AWS_PROFILE=wick-dev}"
export AWS_REGION=${AWS_REGION:-us-east-1}
here=$(cd "$(dirname "$0")" && pwd)
key=${RIFF_DEPLOY_KEY:-$HOME/.ssh/riff-lightsail}

echo "== 1/4 Terraform state bucket"
"$here/bootstrap-state.sh"

echo "== 2/4 Account stack: the GitHub deploy role (review the plan, then type yes)"
terraform -chdir="$here/account" init -input=false >/dev/null
terraform -chdir="$here/account" apply

echo "== 3/4 Production stack: adopt the server and create the secrets (review, then yes)"
terraform -chdir="$here/prod" init -input=false >/dev/null
terraform -chdir="$here/prod" apply

echo "== 4/4 Secrets"
if aws secretsmanager get-secret-value --secret-id riff/prod/deploy >/dev/null 2>&1; then
  echo "Deploy key already stored."
else
  [[ -f $key ]] || { echo "Deploy key $key not found (set RIFF_DEPLOY_KEY)." >&2; exit 1; }
  aws secretsmanager put-secret-value --secret-id riff/prod/deploy \
    --secret-string "file://$key" >/dev/null
  echo "Stored the deploy SSH key in riff/prod/deploy."
fi

read -r -p "Twitch Client ID (Enter to leave unchanged): " twitch_id
if [[ -n $twitch_id ]]; then
  read -r -s -p "Twitch Client Secret: " twitch_secret
  echo
  current=$(aws secretsmanager get-secret-value --secret-id riff/prod/shared \
    --query SecretString --output text)
  # Pass the merged JSON through a private temp file, so the secret never appears in a
  # process list (command arguments) or in shell history.
  tmp=$(mktemp)
  chmod 600 "$tmp"
  trap 'rm -f "$tmp"' EXIT
  TWITCH_SECRET=$twitch_secret jq -c --arg id "$twitch_id" \
    '.TWITCH_CLIENT_ID = $id | .TWITCH_CLIENT_SECRET = env.TWITCH_SECRET' <<<"$current" > "$tmp"
  aws secretsmanager put-secret-value --secret-id riff/prod/shared \
    --secret-string "file://$tmp" >/dev/null
  rm -f "$tmp"
  unset twitch_secret current
  echo "Stored the Twitch application in riff/prod/shared."
fi

cat <<'DONE'

Setup complete. Push to main (or run the "Deploy" workflow) to deploy.
Console passwords and sign-in links: see "Streamer access" in infra/deploy/README.md.
DONE
