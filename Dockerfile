# ghcr.io/yea-protocol/yea: the yea CLI with zero Node setup on your side.
#   docker run --rm ghcr.io/yea-protocol/yea demo
#   docker run --rm -p 7447:7447 ghcr.io/yea-protocol/yea openapi https://petstore3.swagger.io/api/v3/openapi.json --base https://petstore3.swagger.io/api/v3 --host 0.0.0.0
# Node runs only on the build machine's own platform: under QEMU it can crash, and the build then hangs.
# The installed tree is pure JavaScript, so the image for every platform copies the same files.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY ts/package.json ts/
COPY cli/package.json cli/
COPY mcp/package.json mcp/
RUN npm ci -w @yea-protocol/sdk -w @yea-protocol/mcp -w @yea-protocol/cli --include-workspace-root=false --ignore-scripts
COPY ts ts
COPY cli cli
COPY mcp mcp
# --ignore-scripts: ts/'s prepack syncs its npm README from the root README, which the image doesn't need.
RUN npm run build -w @yea-protocol/sdk && npm run build -w @yea-protocol/mcp && mkdir /pkgs && npm pack -w @yea-protocol/sdk -w @yea-protocol/mcp -w @yea-protocol/cli --pack-destination /pkgs --silent --ignore-scripts
# One project holds all three packages, so the CLI's SDK and MCP dependencies resolve to this build, not the registry.
WORKDIR /opt/yea
RUN npm init -y >/dev/null && npm install --omit=dev /pkgs/*.tgz
# Every platform's image gets these files, so a platform-specific package (os, cpu, libc or an install script) fails the build.
RUN node -e 'const { packages } = require("./package-lock.json"); \
  const specific = Object.keys(packages).filter((path) => ["os", "cpu", "libc", "hasInstallScript"].some((key) => key in packages[path])); \
  if (specific.length) { console.error("platform-specific, so not installable once for every platform:", specific.join(" ")); process.exit(1); }'

FROM node:22-alpine
COPY --from=build /opt/yea /opt/yea
RUN adduser -D yea
ENV PATH=/opt/yea/node_modules/.bin:$PATH
USER yea
WORKDIR /home/yea
EXPOSE 7447 8080
ENTRYPOINT ["yea"]
CMD ["--help"]
