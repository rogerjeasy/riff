# Resolve and pin image digests when promoting a tested image to deployment.
FROM node:22.23.2-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22.23.2-bookworm-slim AS runtime
ENV NODE_ENV=production RIFF_HOST=0.0.0.0 RIFF_ALLOW_REMOTE=true RIFF_PORT=8787
ENV RIFF_DB_PATH=/opt/riff/data/riff.db RIFF_COMPILER_MODE=mock
WORKDIR /opt/riff/apps/server
# Preserve the workspace graph. This foundation image includes development dependencies;
# a validated production pruning strategy is a separate deployment gate.
COPY --from=build --chown=node:node /workspace/node_modules /opt/riff/node_modules
COPY --from=build --chown=node:node /workspace/packages /opt/riff/packages
COPY --from=build --chown=node:node /workspace/apps/server ./
COPY --from=build --chown=node:node /workspace/apps/web/dist /opt/riff/apps/web/dist
RUN mkdir -p /opt/riff/data && chown node:node /opt/riff/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:8787/api/health'); process.exit(r.ok ? 0 : 1)"
CMD ["node", "dist/index.js"]
