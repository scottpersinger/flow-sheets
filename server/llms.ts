// /llms.txt: what the app is and how an agent connects to it, as Markdown. The site itself is a single-page
// app, so an agent that fetches it without running scripts sees nothing; this is the page it can read.

/** The file for this origin. `mcp` is whether the plugin's MCP server is mounted here (and so worth describing). */
export function llmsTxt(origin: string, mcp: boolean): string {
  const about = `# Universal Docs

> Universal Docs is a web app for text documents, Markdown files, spreadsheets and slide presentations, with a place for stored files (PDFs, pictures, videos, web pages). It imports Word, Excel, PowerPoint, CSV and Markdown files.

The app is at ${origin}. It is a single-page app: its pages need a browser, so read this file rather than the site's HTML.
`;
  if (!mcp) return `${about}\n## Links\n\n- [Support](${origin}/support)\n- [Privacy Policy](${origin}/privacy)\n- [Terms of Service](${origin}/terms)\n`;
  return `${about}
## MCP server

Universal Docs has a remote MCP server, so an agent can read and edit the files in a person's account.

- Endpoint: \`${origin}/mcp/v2\` (streamable HTTP)
- Sign-in: OAuth 2.1. The person signs in to their own Universal Docs account and allows the agent; there are no API keys.
- Scopes: \`files:read\`, \`files:write\`
- Discovery: \`${origin}/.well-known/oauth-protected-resource/mcp/v2\` and \`${origin}/.well-known/oauth-authorization-server\`

### Connect with a browser on the same machine

Any MCP client that supports remote servers with OAuth can use the endpoint directly. In Claude Code:

\`\`\`sh
claude mcp add --transport http universal-docs ${origin}/mcp/v2
\`\`\`

The client opens a browser for the sign-in (authorization code flow with PKCE; dynamic client registration and client ID metadata documents are both supported).

### Connect without a browser (remote or headless agents)

The server supports the OAuth device authorization grant (RFC 8628). With [mcp-remote](https://github.com/punkpeye/mcp-remote):

\`\`\`sh
npx -y mcp-remote ${origin}/mcp/v2 --device-code
\`\`\`

Run that once in a terminal. It prints the address ${origin}/oauth/device and a short code. The person opens the address in any browser, on any machine, enters the code, signs in and allows the agent. The tokens are then saved, and later runs need no one. As a stdio server in an MCP client's configuration:

\`\`\`json
{ "command": "npx", "args": ["-y", "mcp-remote", "${origin}/mcp/v2", "--device-code"] }
\`\`\`

Do the first sign-in in a terminal before starting the client: a client that launches the command itself usually hides the code and gives up before anyone can enter it. The person can see and disconnect these agents under Settings in the app.

### What the tools do

- Files: list, open, create, rename, delete and import (from a web address) documents, Markdown files, spreadsheets, presentations and stored files.
- Local files: \`upload_file\` returns a one-time address; POST the file's bytes to it (\`curl --data-binary @file <address>\`). Use it for files on the agent's own disk.
- Folders: \`list_files\` shows each file's folder and the folders there are; \`create_folder\` and \`move_file\` organize them, and \`upload_file\` can upload into one.
- Documents and Markdown: read as numbered blocks; insert, replace and delete blocks; replace text; format text and blocks; page setup.
- Spreadsheets: read and write ranges (formulas included), insert and delete rows and columns, sort, filter, format, freeze panes, tabs.
- Presentations: read a deck, add, update, move and delete slides, edit elements, set the theme.
- Stored files: read a file as it is, read its text, view and transform pictures.

Read before editing (\`read_doc\`, \`read_deck\`, \`get_sheet_overview\`): block and slide numbers change after inserts and deletes.

## Links

- [Support](${origin}/support)
- [Privacy Policy](${origin}/privacy)
- [Terms of Service](${origin}/terms)
`;
}
