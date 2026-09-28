<script setup lang="ts">
/** Two ways in after the hero: the framework for an existing MCP server, or the protocol itself. */
import { withBase } from 'vitepress';
</script>

<template>
  <section class="band paths" aria-label="Where to start">
    <div class="path">
      <h2>I have an MCP server</h2>
      <p class="prose">
        Guard one risky tool with one call. Before it runs, your server shows the person its plan in their client and asks
        them to type a phrase. The model can't approve it through the tool call, and this first step needs no keys, no
        policy and no account.
      </p>
      <p class="tag">Unreleased: <code>@yea-protocol/mcp</code> and <code>yea-mcp</code> aren't on npm or PyPI yet. The guides install them from the repo.</p>
      <ul class="links">
        <li><a :href="withBase('/guide/mcp-typescript')">Add YEA to your MCP server: TypeScript</a></li>
        <li><a :href="withBase('/guide/mcp-python')">Add YEA to your MCP server: Python</a></li>
      </ul>
    </div>

    <div class="path">
      <h2>I'm building an agent or service</h2>
      <p class="prose">
        Make a service agents can use safely: build one in TypeScript or Python, or wrap an OpenAPI spec. Give an agent
        YEA services through the bridge, an MCP server for Claude Code, Cursor and other clients; when a commit needs
        consent, the bridge never approves on the model's behalf.
      </p>
      <p class="tag warn">
        Keep the principal key where the agent can't reach it. An agent with shell access that can read it can sign its own
        consent. <a :href="withBase('/guide/security')">Security model</a>
      </p>
      <ul class="links">
        <li><a :href="withBase('/guide/quickstart')">Quickstart</a></li>
        <li><a :href="withBase('/guide/build-a-service')">Build a service</a></li>
        <li><a :href="withBase('/guide/claude-code')">Use it from Claude Code</a></li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.paths { display: grid; grid-template-columns: 1fr 1fr; gap: 0; padding-block: clamp(56px, 6vw, 80px); }
.path { display: grid; gap: 18px; align-content: start; padding-right: clamp(24px, 4vw, 56px); }
.path + .path { padding: 0 0 0 clamp(24px, 4vw, 56px); border-left: 1px solid var(--vp-c-divider); }
.path h2 { font-size: clamp(1.5rem, 1.2rem + 1vw, 1.9rem); }
.tag { font-size: 0.9375rem; color: var(--vp-c-text-2); padding: 10px 14px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-alt); }
.warn { color: var(--vp-c-text-1); }
.tag code { font-family: var(--l-mono); font-size: 0.88em; color: var(--vp-c-text-1); }
.links { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.links a { display: inline-flex; align-items: center; min-height: 44px; font-weight: 650; }

@media (max-width: 860px) {
  .paths { grid-template-columns: 1fr; gap: 48px; }
  .path, .path + .path { padding: 0; border: 0; }
}
</style>
