# ghcr.io/yea-protocol/yea: the yea CLI with zero Node setup on your side.
#   docker run --rm ghcr.io/yea-protocol/yea demo
#   docker run --rm -p 7447:7447 ghcr.io/yea-protocol/yea openapi https://petstore3.swagger.io/api/v3/openapi.json --base https://petstore3.swagger.io/api/v3 --host 0.0.0.0
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY ts/package.json ts/
COPY cli/package.json cli/
COPY mcp/package.json mcp/
RUN npm ci -w @yea-protocol/sdk -w @yea-protocol/mcp -w @yea-protocol/cli --include-workspace-root=false --ignore-scripts
COPY ts ts
COPY cli cli
COPY mcp mcp
RUN npm run build -w @yea-protocol/sdk && npm run build -w @yea-protocol/mcp && mkdir /pkgs && npm pack -w @yea-protocol/sdk -w @yea-protocol/mcp -w @yea-protocol/cli --pack-destination /pkgs --silent

FROM node:22-alpine
COPY --from=build /pkgs /pkgs
# One project holds all three packages, so the CLI's SDK and MCP dependencies resolve to this build, not the registry.
WORKDIR /opt/yea
RUN npm init -y >/dev/null && npm install --omit=dev /pkgs/*.tgz && rm -rf /pkgs && adduser -D yea
ENV PATH=/opt/yea/node_modules/.bin:$PATH
USER yea
WORKDIR /home/yea
EXPOSE 7447 8080
ENTRYPOINT ["yea"]
CMD ["--help"]
