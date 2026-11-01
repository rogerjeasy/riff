#!/bin/sh
# First-boot setup for a Riff host (Ubuntu 24.04). Passed as Lightsail user data; runs as root.
# Lightsail runs user data with /bin/sh (dash), so this stays POSIX: no pipefail or bashisms.
set -eux

# Builds and five small app containers fit in 2 GB with a modest swap file.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl rsync openssl unattended-upgrades
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu

# Keep container logs bounded.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker

mkdir -p /opt/riff/src /opt/riff/deploy/tenants /opt/riff/backups
chown -R ubuntu:ubuntu /opt/riff
chmod 700 /opt/riff/deploy /opt/riff/backups
touch /var/lib/riff-bootstrap-done
