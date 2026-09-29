# Hosted demo (Cloudflare Workers)

The example calendar and shop services, hosted, with one private copy per agent key (a Durable
Object per `(service, proof.key)`), so anyone can try YEA from Claude Code without running
anything:

```sh
npx @yea-protocol/cli init
npx @yea-protocol/cli grant --risk low --each spend=40.00USD --total spend=100.00USD --exp 24h
claude mcp add yea-demo -- npx @yea-protocol/cli mcp https://yea-demo.<account>.workers.dev/calendar/yea https://yea-demo.<account>.workers.dev/shop/yea
```

> **Unreleased:** `@yea-protocol/cli` isn't on npm yet, so these `npx` commands fail for now.
> Until it's published, run the same commands from a clone, with `node cli/bin/yea.js` in place of
> `npx @yea-protocol/cli`:
>
> ```sh
> git clone https://github.com/yea-protocol/yea && cd yea
> npm ci && npm run build
> ```

The demo trusts **any** principal (its data is fake and per-agent), so bring your own keys.

```sh
npm run build              # at the repo root (the worker imports @yea-protocol/sdk)
cd deploy/demo
npx wrangler dev           # local
npx wrangler deploy        # needs `wrangler login`
```
