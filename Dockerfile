# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN apt-get update \
  && apt-get install --yes --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @clinmesh/web build && pnpm --filter @clinmesh/server build
RUN pnpm --filter @clinmesh/server deploy --prod --legacy /opt/clinmesh

FROM node:22.19.0-bookworm-slim AS runtime

ENV CLINMESH_DATABASE_PATH=/var/lib/clinmesh/clinmesh.sqlite
ENV CLINMESH_HOST=0.0.0.0
ENV CLINMESH_PORT=8787
ENV CLINMESH_WEB_ROOT=/opt/clinmesh/web
WORKDIR /opt/clinmesh

RUN groupadd --system clinmesh && useradd --system --gid clinmesh --home /opt/clinmesh clinmesh
COPY --from=build --chown=clinmesh:clinmesh /opt/clinmesh ./
COPY --from=build --chown=clinmesh:clinmesh /workspace/apps/web/dist ./web
RUN mkdir -p /var/lib/clinmesh && chown clinmesh:clinmesh /var/lib/clinmesh

USER clinmesh
VOLUME ["/var/lib/clinmesh"]
EXPOSE 8787
ENTRYPOINT ["sh", "/opt/clinmesh/container-entrypoint.sh"]
