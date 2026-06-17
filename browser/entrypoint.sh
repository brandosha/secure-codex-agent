#!/bin/bash
set -e

# Use the passed HOST_UID env variable, or default to 10000
TARGET_UID=${HOST_UID:-10000}

# Update the agent's UID to match the host
if [ "$(id -u agent)" -ne "$TARGET_UID" ]; then
    echo "Updating agent UID to match host: $TARGET_UID"
    usermod -u "$TARGET_UID" agent
    # Fix ownership of the home directory if needed
    chown -R agent:agent /home/agent
fi

mkdir -p /home/agent/.browser-data/profile
chown -R agent:agent /home/agent/.browser-data

exec gosu agent python server.py
