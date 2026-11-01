#!/usr/bin/env bash
# Ship a built image and its configuration to the Riff host: infra/deploy/ship.sh <image-tag>
# Runs in CI after `terraform apply` (needs AWS credentials and a local image riff:<tag>).
# Secrets go from Secrets Manager to the host over SSH stdin; never into argv or logs.
set -euo pipefail
tag=${1:?usage: ship.sh <image-tag>}
here=$(cd "$(dirname "$0")" && pwd)
tf="terraform -chdir=$here/../terraform/prod"
host=$($tf output -raw host)
domain=$($tf output -raw base_domain)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
secret() { aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text; }
(umask 077
  secret riff/prod/deploy > "$work/key"
  secret riff/prod/shared > "$work/shared.json"
  secret riff/prod/streamers > "$work/streamers.json")
# The host key is pinned in the repository; an unexpected key aborts the deploy.
ssh_opts=(-i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$here/known_hosts" -o ConnectTimeout=15)
remote() { ssh "${ssh_opts[@]}" "ubuntu@$host" "$@"; }

echo "Installing riffctl on $host"
remote 'mkdir -p /opt/riff/bin && cat > /opt/riff/bin/riffctl.next' < "$here/riffctl"
remote 'chmod 755 /opt/riff/bin/riffctl.next && mv /opt/riff/bin/riffctl.next /opt/riff/bin/riffctl \
  && sudo ln -sf /opt/riff/bin/riffctl /usr/local/bin/riffctl && rm -rf /opt/riff/src'

if remote "docker image inspect riff:$tag >/dev/null 2>&1"; then
  echo "Host already has riff:$tag"
else
  echo "Sending riff:$tag"
  docker save "riff:$tag" | gzip -1 | remote 'gunzip | docker load'
fi

echo "Applying configuration"
jq -n --arg domain "$domain" --slurpfile shared "$work/shared.json" \
  --slurpfile streamers "$work/streamers.json" \
  '{base_domain: $domain, shared: $shared[0],
    streamers: ($streamers[0] | map_values({RIFF_SECRET, CONSOLE_PASSWORD_BCRYPT, ACCESS_TOKEN}))}' \
  | remote "riffctl sync $tag"

for name in $(jq -r 'keys[]' "$work/streamers.json"); do
  url="https://$name.$domain/api/health"
  curl -fsS --retry 12 --retry-delay 5 --retry-all-errors -o /dev/null "$url"
  echo "Healthy: https://$name.$domain"
done
