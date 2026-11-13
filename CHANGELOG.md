# Changelog

All notable changes to `ltcook` will be documented in this file.

> [!IMPORTANT]
> ## Rules
> 1) Do not remove or change this header and TOC without very good reason. 
> 1) When bumping version, move the sub-sections from `[Unreleased]` to
>    the new version -section. Remove empty sub-sections under released
>    versions. Provide a new `[Unreleased]` section at the top of the
>    changelog with all sections empty (don't remove those).
> 1) Do not remove emojis and use `<br>` and `---`.
> 1) Changelog entries must describe the final net difference from the
>    previous released version. Do not list intermediate pre-release
>    names, helper shapes, fixes, or refactors that were overwritten
>    before release.
> 1) Use `🔨 Fixed` only for defects in previously released behavior.
>    For new features, describe the final shipped behavior under `➕
>    Added`, even if the implementation went through pre-release fixes.



<br>

---

<br>

## Table Of Contents

1. [Changelog](#changelog)
   1. [Table Of Contents](#table-of-contents)
2. [\[Unreleased\]](#unreleased)

<br>

---

<br>

<!-- ======================================================== -->

# [Unreleased]

<br>

### 💥 Breaking changes

<br>

### ➕ Added

<br>
- Initialized a separate `ltcook` application from Buildben, preserving the
  existing `lcook` application and its data.
- Added a Bun development workspace and packaged Node runtime using Pi agents
  and Paseo's native chat and plugin interfaces.
- Added interchangeable default and two-agent teams, durable SQLite coordination,
  scoped agent commands and restart recovery without LCook compatibility code.
- Added AppRC-managed settings, private dependency preparation and scoped
  installation, service and cleanup helpers.
- Added pinned SearXNG/Crawl4AI Compose configuration, optional research tools,
  redacted local diagnostics and fast isolated behavior checks.

### 💔 Changed

<br>

### ⚠️ Deprecated

<br>

### 🗑️ Removed

<br>

### 🔨 Fixed

<br>

### 🔒 Security

<br>

---

<br>

