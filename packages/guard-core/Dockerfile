# Build from the repository root with --dockerfile: see "Deploy on Fly.io" in this package's README.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
# Only the files guard-core runs from, so no .env, key file or test can end up in a layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The pnpm override's local packages (pnpm-workspace.yaml).
COPY vendor vendor
COPY packages/shared/package.json packages/shared/
COPY packages/onchain/package.json packages/onchain/
COPY packages/guard-core/package.json packages/guard-core/
# better-sqlite3 ships its prebuilt bindings in the package and esbuild (for tsx) its binary as an
# optional dependency, so no install script has to run, and no compiler is needed.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @defimind/guard-core...
COPY packages/shared/src packages/shared/src
COPY packages/onchain/src packages/onchain/src
COPY packages/onchain/web/page.ts packages/onchain/web/
COPY packages/onchain/web/src packages/onchain/web/src
COPY packages/guard-core/src packages/guard-core/src
COPY packages/guard-core/migrations packages/guard-core/migrations
COPY packages/guard-core/deploy packages/guard-core/deploy
RUN pnpm --filter @defimind/guard-core deploy --prod --legacy --ignore-scripts /out

# The owner panel (CR-012): static files, built here and served by guard-core at /panel.
FROM node:22-slim AS panel
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor vendor
COPY packages/shared/package.json packages/shared/
COPY packages/panel/package.json packages/panel/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @defimind/panel...
COPY packages/shared/src packages/shared/src
COPY tsconfig.base.json ./
COPY packages/panel/build.ts packages/panel/icons.ts packages/panel/logo.ts packages/panel/tsconfig.json packages/panel/tsconfig.sw.json packages/panel/
COPY packages/panel/src packages/panel/src
COPY packages/panel/public packages/panel/public
RUN pnpm --filter @defimind/panel build

# The signing page (CR-019): onchain's build, served by guard-core at /sign with its own hot wallets.
FROM node:22-slim AS sign
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor vendor
COPY packages/shared/package.json packages/shared/
COPY packages/onchain/package.json packages/onchain/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @defimind/onchain...
COPY packages/shared/src packages/shared/src
COPY packages/onchain/src packages/onchain/src
COPY packages/onchain/web/build.ts packages/onchain/web/page.ts packages/onchain/web/
COPY packages/onchain/web/src packages/onchain/web/src
COPY packages/onchain/web/public packages/onchain/web/public
RUN pnpm --filter @defimind/onchain build:web

FROM node:22-slim
ENV NODE_ENV=production
ENV PANEL_DIR=/srv/defimind/packages/panel/dist
ENV SIGN_DIR=/srv/defimind/packages/onchain/web/dist
# The same depth as in the repository, so db/placement.ts takes /srv/defimind as the repo root
# and the /data volume counts as outside it.
WORKDIR /srv/defimind/packages/guard-core
COPY --from=build /out .
COPY --from=panel /repo/packages/panel/dist /srv/defimind/packages/panel/dist
COPY --from=sign /repo/packages/onchain/web/dist /srv/defimind/packages/onchain/web/dist
# Starts as root only to mount tmpfs for the hot keys, then runs node as the node user.
ENTRYPOINT ["./deploy/entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/main.ts"]
