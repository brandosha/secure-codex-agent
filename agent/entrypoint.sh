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


AGENT_GITCONFIG="/home/agent/.gitconfig"

if [ -n "$GIT_USER_NAME" ] && [ -n "$GIT_USER_EMAIL" ]; then
    echo "Setting up Git authorship for the agent user..."
    
    # Force Git to write directly to the agent's file, even though we are root
    git config --file "$AGENT_GITCONFIG" user.name "$GIT_USER_NAME"
    git config --file "$AGENT_GITCONFIG" user.email "$GIT_USER_EMAIL"
else
    echo "Warning: GIT_USER_NAME and GIT_USER_EMAIL variables not set, using default values."
    git config --file "$AGENT_GITCONFIG" user.name "Agent"
    git config --file "$AGENT_GITCONFIG" user.email "agent@agent.internal"
fi
chown agent:agent "$AGENT_GITCONFIG"

export CI=true
exec pnpm run start