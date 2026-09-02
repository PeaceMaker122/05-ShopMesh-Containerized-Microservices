# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies first so this layer is cached across builds.
COPY package.json ./
RUN npm install --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine
WORKDIR /app

# Run as a non-root user to limit privileges if the container is compromised.
USER node

# Copy only the production dependencies and application code from the builder.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node src ./src

EXPOSE 3000
CMD ["node", "src/server.js"]