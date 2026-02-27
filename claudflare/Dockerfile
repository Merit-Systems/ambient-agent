FROM docker.io/cloudflare/sandbox:0.5.1

RUN npm install -g @anthropic-ai/claude-code
ENV COMMAND_TIMEOUT_MS=300000
EXPOSE 3000

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt update && \
    apt install -y gh

# Create a non-root user for running claude code
RUN useradd -m -s /bin/bash claudeuser && \
    echo 'claudeuser:claudeuser' | chpasswd && \
    chown -R claudeuser:claudeuser /home/claudeuser
