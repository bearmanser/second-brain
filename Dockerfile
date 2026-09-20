ARG NODE_IMAGE=node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
FROM ${NODE_IMAGE} AS build

WORKDIR /app

RUN apk add --no-cache --virtual .build-deps python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache libstdc++

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER 1000:1000

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
