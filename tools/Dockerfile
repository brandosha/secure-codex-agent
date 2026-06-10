# Start with the Node slim base for your supervisor
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    gosu \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

# Create the agent user
RUN useradd -m -s /bin/bash agent

# Set up the application directory
WORKDIR /app

# Copy the entrypoint script and make it executable
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
