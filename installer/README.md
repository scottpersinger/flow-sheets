# @scottpersinger/mcp-docs

Installs **MCP Docs**, a Mac app for Word, PowerPoint and Excel files, Markdown, CSV, PDFs and pictures in a
folder on your Mac, and the **mcp-docs** plugin for [Claude Code](https://claude.com/claude-code), which lets
Claude Code open and edit those files while you watch them change in the app.

```
npx @scottpersinger/mcp-docs
```

This:

1. Downloads the latest MCP Docs release from GitHub and puts it in `/Applications` (or `~/Applications`),
   replacing an older version.
2. Adds the `mcp-docs` plugin marketplace to Claude Code and installs the `mcp-docs` plugin: the app's MCP
   server (`http://127.0.0.1:39217/mcp`) and a skill describing how to use it.
3. Starts the app.

Then restart Claude Code, run `/mcp`, and sign in to `plugin:mcp-docs:mcp-docs`; the app asks you to allow
it. Run `npx @scottpersinger/mcp-docs` again to update both.

Options: `--skip-app` (plugin only), `--skip-plugin` (app only).

Requires a Mac with Apple silicon and Node.js 18 or later.
