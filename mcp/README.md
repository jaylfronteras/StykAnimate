# StykAnimate MCP

An [MCP](https://modelcontextprotocol.io) server that lets an assistant drive this StykAnimate fork: build a scene from a description, edit the open project, design a figure, preview frames, and export video. Edits use the app's own editor, document model, and file format. A headless browser starts only when a tool paints or exports.

The server speaks stdio and is licensed GPL-3.0-or-later, the same as the app. See `NOTICE` for credits.

## Install

From a checkout of this repository, with Node 22 or newer (releases use Node 24.11.0):

```bash
cd mcp
npm ci
```

`ffmpeg` is required for `preview_gif` and `export_video`. Python 3.12 and the repo's `codecs/` tree are required only for Pivot `.piv` and `.stk` import and export. Both are optional for every other tool.

Start the server (it waits on stdin; a client launches it):

```bash
node src/index.js
```

## Workspace

Every path the tools accept stays inside `STYK_WORKSPACE`. When that variable is unset, the workspace is `./stykanimate-workspace` under the process working directory. The server creates `figures/` and `exports/` there.

`project_save` refuses to replace an existing file unless `overwrite` is true. An overwrite keeps the previous bytes as a `.bak` beside the file. Saving does not replace the file you opened unless you pass that same path and `overwrite`.

## Client configuration

Use the absolute path to `mcp/src/index.js` and to the folder where projects should live.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stykanimate": {
      "command": "node",
      "args": ["/absolute/path/to/StykAnimate/mcp/src/index.js"],
      "env": {
        "STYK_WORKSPACE": "/absolute/path/to/projects",
        "STYK_RENDER": "software"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in the project, or Cursor Settings → MCP:

```json
{
  "mcpServers": {
    "stykanimate": {
      "command": "node",
      "args": ["/absolute/path/to/StykAnimate/mcp/src/index.js"],
      "env": {
        "STYK_WORKSPACE": "/absolute/path/to/projects",
        "STYK_RENDER": "software"
      }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.stykanimate]
command = "node"
args = ["/absolute/path/to/StykAnimate/mcp/src/index.js"]

[mcp_servers.stykanimate.env]
STYK_WORKSPACE = "/absolute/path/to/projects"
STYK_RENDER = "software"
```

Omit `STYK_RENDER` to let preview and export try headless Chrome (Playwright, system Chrome) and fall back to the built-in rasterizer. `STYK_RENDER=browser` fails the tool when Chrome cannot start. `STYK_RENDER=software` is what the tests use.

## How an assistant should use it

Call `scenario_guide` before the first scene. It is the spec for `scenario_build`: canvas, cast, beats, motions, camera, and the file-format limits.

1. `scenario_build` compiles one spec into a normal project. If nothing is open, it creates a project first. The previous project is snapshotted.
2. Edit with `figure_*`, `pose_*`, `keyframe_*`, `tween_set`, `layer_*`, `camera_*`, `text_*`, `audio_*`, `motion_apply`, and `scenario_append`. `scenario_append` adds beats without replacing the document.
3. `preview_frames` returns a PNG contact sheet as an MCP image. `export_video` writes an H.264 mp4 or a GIF (`youtube`, `shorts`, `tiktok`, `gif`, or `canvas`).
4. `figure_design` builds a figure from a base (`stickman`, `chibi`, `tall`, `bulky`), proportions, a head, and parts from `parts_list`. `figure_preview` draws a pose sheet. `figure_library_save` stores a reusable `.stkz` under the workspace.

`project_save` writes `.styk` (the full project), `.stkz` (one figure), `.json` (a debug copy the app loader can read), or `.piv` / `.stk` when Python is available. Multi-key scenes round-trip through Pivot; keep finished timelines in `.styk`.

## Safety

Every mutating tool runs through the app's editor commands, then `validateScene`. If validation or the command throws, the server undoes back to the revision from before the tool and returns the error. `expect_revision` rejects a stale edit. `snapshot_create` keeps up to eight full documents; `scenario_build` takes one automatically. `history_undo` and `history_redo` are the editor's own undo stack. `load` clears that stack, so restoring a snapshot is what brings a replaced document back.

## Tests

```bash
cd mcp
npm test
```

The suite covers the tool list, rollback, the workspace sandbox, a compiled walk, figure parts that follow a pose, Pivot and audio files, and an end-to-end scene: about ten seconds, two characters, a later edit, a designed figure, preview PNGs, an mp4, and a reopen through the app's loader.

## Layout

`src/core.js` is the only file that imports the app. Upstream renames of editor entry points are fixed there. `UPSTREAM-CHANGES.md` lists every edit outside `mcp/`. `UPSTREAM-SYNC.md` is the runbook for merging a new app release into this fork.
