ARG NODE_IMAGE=node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG PYTHON_IMAGE=python@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9

FROM ${NODE_IMAGE} AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY workers ./workers
RUN npm run build
RUN npm prune --omit=dev

FROM ${PYTHON_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config/laya-model.lock.json ./config/laya-model.lock.json
COPY workers/laya/requirements.lock ./workers/laya/requirements.lock
RUN pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all: \
  -r workers/laya/requirements.lock
COPY workers ./workers

USER 1000:1000

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
