FROM node:20-alpine

# Which API to build — pass at build time:
#   docker build --build-arg API_DIR=api-cricket -t cricket-api:latest .
ARG API_DIR

WORKDIR /app

# Copy dependency manifests first (better layer caching)
COPY package*.json ./

# Install curl, netcat + production dependencies
RUN apk add --no-cache curl netcat-openbsd && \
    npm install --omit=dev && \
    npm cache clean --force

# Copy shared TLS helper (lives at repo root alongside this Dockerfile)
COPY tls-helper.js ./tls-helper.js

# Copy only the specific API's server.js
COPY ${API_DIR}/server.js ./server.js

# OpenShift arbitrary UID support (GID=0 is always present)
RUN chgrp -R 0 /app && \
    chmod -R g+rwX /app

# Non-root user (OpenShift overrides UID but respects this as fallback)
USER 1001

EXPOSE 8443

CMD ["node", "server.js"]