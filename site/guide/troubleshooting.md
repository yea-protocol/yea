# Troubleshooting

Start with:

```sh
npx @yea-protocol/cli doctor
```

It checks your node version, keys, grants, services and AI-tool registration, and says what to run for each problem.

## My AI tool doesn't show the YEA tools

- Restart the tool after `yea install` or `yea add`. Most clients read MCP config only at startup.
- Run `yea doctor` and look for "registered with". If your tool isn't listed, run `yea install --target <tool>`, or add it by hand from [Integrations](/guide/integrations).
- In Claude Code, `claude mcp list` should show `yea`. The installer sets `alwaysLoad` so the tools aren't hidden behind deferred tool search.
- `npx` needs Node 20 or newer on the `PATH` your tool uses. GUI apps sometimes see a different `PATH` than your shell; use an absolute path to `npx` in the config if so.

## The tools are there, but there are no capabilities

The bridge serves the services in `yea services`. Add one with `yea add <url>`, or start the examples with `yea examples` and add `yea://127.0.0.1:7447` and `yea://127.0.0.1:7449`.

## `unauthorized`

- **"needs a grant from your principal"**: there's no grant for this agent key. Run `yea grant …` as the principal (`yea doctor` lists your grants).
- **"proof timestamp is outside the 300s window"**: your clock is off by more than five minutes. Fix the system time.
- **"grant is issued by a principal this service does not trust"**: the service doesn't trust your principal key. For `yea examples` and `yea openapi`, set `YEA_TRUST` to your principal's public key (`yea whoami`).
- **"proof key is not the grant holder"**: the grant was issued to a different key than the one signing. `yea doctor` flags grants "held by another key".

## `forbidden`

A valid grant doesn't cover this request, and `need` lists the caveats that blocked it, for example `[{"svc":["other.example"]}]`. Issue a grant that covers it, or use the right service.

`forbidden: only the agent that requested this proposal can commit it` means a proposal is being committed by a different agent key than the one that asked for it. Send the `INTENT` again from the committing agent.

## `consent_required`

That's working as intended: the action is outside the policy (per-action cap, total spend or risk ceiling). The human approves it with `yea approve <pc1.code>` where their principal key is, and the agent passes the printed consent to `yea_consent` and calls the tool again. The approval covers that one proposal only.

## `expired`

Proposals are committable for about 10 minutes, handles for at least 10, and undo only inside its window. Send the `INTENT` again for fresh proposals.

## The playground doesn't start

It needs Ed25519 in the browser's WebCrypto: current Chrome, Firefox or Safari.

## Still stuck?

Open an issue with the output of `yea doctor` (it contains public keys only): [github.com/yea-protocol/yea/issues](https://github.com/yea-protocol/yea/issues).
