# chobo CRM —— 多阶段:server(tsc)+ web(vite)分别构建,runtime 只带生产依赖
FROM node:20-bookworm-slim AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY server/ ./
RUN npm run build

FROM node:20-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production TZ=Asia/Shanghai
COPY server/package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force
COPY --from=server-build /app/server/dist ./dist
COPY server/migrations ./migrations
COPY contracts /app/contracts
COPY --from=web-build /app/web/dist /app/web
COPY price-seed.json /app/price-seed.json
EXPOSE 8787
CMD ["node", "dist/server.js"]
