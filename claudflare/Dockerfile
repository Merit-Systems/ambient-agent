FROM docker.io/cloudflare/sandbox:0.5.1

RUN npm install -g @anthropic-ai/claude-agent-sdk agentcash && \
    npm cache clean --force && \
    # Remove ripgrep binaries for platforms we don't need (only keep x64-linux)
    cd /usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep 2>/dev/null && \
    rm -rf arm64-darwin arm64-linux arm64-win32 x64-darwin x64-win32 || true && \
    # Remove wasm files not needed in sandbox
    rm -f /usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/tree-sitter*.wasm 2>/dev/null || true && \
    rm -f /usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/resvg.wasm 2>/dev/null || true && \
    # Create `claude` wrapper using the SDK's bundled CLI (avoids the separate ~80MB claude-code package)
    printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/cli.js "$@"\n' > /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude
ENV COMMAND_TIMEOUT_MS=300000
EXPOSE 3000

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt update && \
    apt install -y gh

# Copy agent runner script
COPY src/agent-runner.mjs /opt/agent-runner.mjs

# Create a non-root user for running claude code
RUN useradd -m -s /bin/bash claudeuser && \
    echo 'claudeuser:claudeuser' | chpasswd && \
    chown -R claudeuser:claudeuser /home/claudeuser
