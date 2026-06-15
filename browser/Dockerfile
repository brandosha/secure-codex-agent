FROM python:3.11-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install system dependencies required by Playwright/Chromium on Linux
RUN apt-get update && apt-get install -y \
    curl \
    gosu \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Create the agent user
RUN useradd -m -s /bin/bash agent

WORKDIR /app

# Install browser-use, playwright, and fastmcp
RUN pip install browser-use playwright fastmcp fastapi uvicorn langchain-openai

# Install the chromium browser binary and its system libraries in a shared path
RUN mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
    && playwright install --with-deps chromium \
    && chmod -R 755 "$PLAYWRIGHT_BROWSERS_PATH"

# Copy the server entrypoint into the container
COPY entrypoint.sh server.py ./
RUN chmod +x entrypoint.sh

# We use a shell script or entrypoint to boot both Chrome and our API
CMD ["./entrypoint.sh"]
