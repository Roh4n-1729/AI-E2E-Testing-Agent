# AI E2E Agent, deployed (README, "Deploying"). Two stages: build the UI with the dev tools, then a runtime
# with only production packages and Playwright's Chromium (version from package-lock.json).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run ui:build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    AIE2E_HEADLESS=true
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/ui/dist ./ui/dist
COPY src ./src
COPY examples ./examples
COPY deploy ./deploy
# runs and recordings are written here; the app runs as the unprivileged "node" user
RUN mkdir -p /app/.aie2e && chown -R node:node /app/.aie2e
USER node
EXPOSE 10000
ENV PORT=10000
CMD ["node", "deploy/serve.js"]
