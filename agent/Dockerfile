# Start with the Node slim base for your supervisor
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    sudo \
    ripgrep \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create the agent user
RUN useradd -m -s /bin/bash agent
RUN echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers


RUN corepack enable pnpm

# Set up the application directory
WORKDIR /app

# Install dependencies
COPY package*.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy the rest of the application code
COPY . .
RUN chmod +x /app/entrypoint.sh

# Start the application using the entrypoint script
USER root

ENTRYPOINT ["/app/entrypoint.sh"]
