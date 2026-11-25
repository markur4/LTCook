# LTCook patches for Paseo

`timeline-navigation.patch` applies to Paseo `v0.16.0-beta.2` at immutable revision
`23bae61535542a45ade7196a7b3c152705f16de3`. It adds the optional
`navigation.revealTimelineItem` capability to the Plugin Client API supplied by
LTCook's Paseo web app. Activity uses it for **Show in Chat**. The capability is
available only from hosts that implement the action. [Pinned Paseo source](https://github.com/getpaseo/paseo/tree/23bae61535542a45ade7196a7b3c152705f16de3)

The action takes the Paseo host and native agent IDs and an event target with
`epoch`, `position`, `kind`, `id`, `at`, and optional `turnId`. `at` is the event's
timestamp in milliseconds. The epoch and sequence locate the entry, and the
native message or call ID plus any supplied turn ID verify its identity.

The web app reveals the agent through Paseo's workspace navigation. It uses the
same history-window planner and viewport scrolling as Chat Outline and Chat Find.
If the exact row is in a folded turn, it opens that turn. If the selected call
belongs to a tool group, the call appears as an individual row at its position in
the transcript. The action resolves after that row comes into view. A replaced
timeline, unavailable host, or missing event rejects the action with an error.

`session-worktrees.patch` updates **Changes** using the focused conversation's
worktree subscription from LTCook. The **Worktree** picker lets the user pin a
checkout or resume following. When the panel shows a linked checkout, the inline
diff uses its directory and provides read-only controls.

## Build the web assets

Run the builder from the LTCook repository with Node, npm, curl, tar, Git, and
network access to GitHub and the npm registry.

```sh
node paseo-patches/build.mjs
```

The builder verifies the pinned source archive's SHA-256 and applies both patches
in a temporary directory. It installs the upstream lockfile, generates Paseo's
protocol validators, and runs the upstream `build:daemon-web-ui` script. The
default output is `runtime/dist/paseo-web`. Pass an output directory as the first
argument to stage elsewhere. The build marker identifies the upstream revision,
source archive, patches, and builder. Re-running with a matching build marker and
web entry point reuses the staged directory.

LTCook packages these generated assets with its runtime and points the embedded
Paseo server at them through `PASEO_WEB_UI_DIST_DIR`. The native installer
consumes the prebuilt runtime payload.
