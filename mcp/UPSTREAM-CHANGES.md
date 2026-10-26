# Changes outside `mcp/`

This fork keeps the MCP server in `mcp/` so an upstream merge stays small. The app's `src/` is not modified. The only file outside `mcp/` that this package adds or edits:

| File | Change |
| --- | --- |
| `.github/workflows/ci.yml` | Adds the `mcp` job. On every pull request it installs `mcp/` and runs `npm test` there, after the existing app check and unit-test jobs. Node 24.11.0, Python 3.12.9, and ffmpeg match the release workflow. Playwright's browser download is skipped; tests set `STYK_RENDER=software`. |

If a later change has to touch the app, add a row here and keep the import in `mcp/src/core.js`.
