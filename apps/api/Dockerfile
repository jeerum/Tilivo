# ---- base: install all dependencies and build ----
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY migrations ./migrations
COPY tests ./tests
RUN npm run build

# ---- test: dev dependencies + built output ----
FROM base AS test
CMD ["npm", "test"]

# ---- prod: production dependencies only ----
FROM node:22-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=base /app/dist ./dist
COPY --from=base /app/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
