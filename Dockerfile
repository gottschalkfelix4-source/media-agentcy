FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="Media Agentcy" \
      org.opencontainers.image.description="WhatsApp-KI-Assistent für Jellyfin/Plex-Nutzer mit Web-Admin-Oberfläche" \
      org.opencontainers.image.source="https://github.com/gottschalkfelix4-source/media-agentcy" \
      org.opencontainers.image.version="${VERSION}" \
      net.unraid.docker.webui="http://[IP]:[PORT:8080]/" \
      net.unraid.docker.icon="https://raw.githubusercontent.com/gottschalkfelix4-source/media-agentcy/master/unraid/icon.png"
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HTTP_PORT=8080 \
    TZ=Europe/Berlin
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
