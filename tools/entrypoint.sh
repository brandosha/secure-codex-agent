#!/bin/bash
set -e

# Use the passed HOST_UID env variable, or default to 1000
TARGET_UID=${HOST_UID:-1000}
SSH_DIR=/home/agent/.ssh
SSH_KEY_PATH=${SSH_KEY_PATH:-$SSH_DIR/id_ed25519}
SSH_PUBLIC_KEY_PATH="${SSH_KEY_PATH}.pub"

# Update the agent's UID to match the host
if [ "$(id -u agent)" -ne "$TARGET_UID" ]; then
    echo "Updating agent UID to match host: $TARGET_UID"
    usermod -u "$TARGET_UID" agent
fi

mkdir -p "$SSH_DIR"
chown agent:agent "$SSH_DIR"
chmod 700 "$SSH_DIR"

if [ ! -f "$SSH_KEY_PATH" ]; then
    echo "Generating SSH key for Git MCP tool at $SSH_KEY_PATH"
    gosu agent ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "git-mcp-tool"
fi

if [ ! -f "$SSH_PUBLIC_KEY_PATH" ]; then
    echo "Rebuilding missing public key at $SSH_PUBLIC_KEY_PATH"
    gosu agent sh -c "ssh-keygen -y -f \"$SSH_KEY_PATH\" > \"$SSH_PUBLIC_KEY_PATH\""
fi

chown agent:agent "$SSH_KEY_PATH" "$SSH_PUBLIC_KEY_PATH"
chmod 600 "$SSH_KEY_PATH"
chmod 644 "$SSH_PUBLIC_KEY_PATH"

export CI=true
export SSH_KEY_PATH

echo "Git MCP public key:"
cat "$SSH_PUBLIC_KEY_PATH"

# Run the requested container command as 'agent'
cd /home/agent/app
export HOME=/home/agent
exec gosu agent pnpm run start:watch
