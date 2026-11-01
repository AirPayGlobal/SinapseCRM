# Sinapse CRM — API + web application in one image
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --workspaces --include-workspace-root
COPY . .
RUN npm run build -w web && npm run build -w server

FROM node:22-alpine
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
# npm keeps some workspace dependencies (e.g. express 4, pg) in the workspace's own node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/src/db/migrations server/dist/db/migrations
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /var/lib/sinapse/storage && chown -R node /var/lib/sinapse
USER node
WORKDIR /app/server
EXPOSE 4000
CMD ["node", "dist/index.js"]
