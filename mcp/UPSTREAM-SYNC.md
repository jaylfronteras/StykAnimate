# Upstream sync

`origin` is this fork. `upstream` is `filippocalippo/StykAnimate-App`. `main` on the fork tracks upstream. MCP work stays on its own branches and merges through a pull request, the same as an app change.

## Pull a new app release

1. `git fetch upstream --tags`
2. Branch from this fork's `main`: `git checkout -b sync/vX.Y.Z main`
3. Merge the upstream tag: `git merge vX.Y.Z`
4. Fix breakages in `mcp/src/core.js` first. That file is the only import of app internals. If a tool depended on a renamed command, update the call site in `mcp/src/` and add any app-tree edit to `UPSTREAM-CHANGES.md`.
5. Open a pull request. CI runs the app checks (`npm run check`, `npm test`, changelog check, codec tests) and then `cd mcp && npm test`.
6. Read the MCP failures before changing tests. A new app invariant should update the server; a test should change only when the contract changed.

## What the MCP job is guarding

- The editor still loads with `demo: false`, `propertyChannels: true`, and `layerTimeline: true`, matching the desktop app.
- A compiled scene still opens, tweens, saves, and reopens through `decodeDocument`.
- Figure parts still follow a pose, and the parts list still has the v1 library.
- Preview still returns a PNG and export still writes an mp4 when ffmpeg is present.
- Pivot import and export still run when Python can import `codecs/codec_bridge.py`. That test skips only when the codec itself errors.

## After the sync merges

Tag the fork `vX.Y.Z-mcp.N` when the MCP package itself needs a version mark. Do not move the app's `CHANGELOG.md` or package version for an MCP-only change. The desktop changelog is for people using the app.
