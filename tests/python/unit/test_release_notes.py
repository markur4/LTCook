"""Release-note coverage for cumulative changelogs and exact package versions."""

from itertools import pairwise
from pathlib import Path

import pytest

from ltcook_dev.packaging.release_notes import (
    build_release_notes,
    latest_release_version,
    main,
    release_channel,
    validate_next_version,
    validate_tag_version,
    validate_version,
    version_key,
)

UNRELEASED = """## [Unreleased]

### ✨ Added

### 🛠️ Changed

### 🗑️ Deprecated

### 🔥 Removed

### 🐛 Fixed

### 🔒 Security
"""


@pytest.mark.parametrize(
    ("version", "channel"),
    [
        ("0.2.0b1", "beta"),
        ("0.2.0rc2", "pre-release"),
        ("0.2.0", "stable"),
    ],
)
def test_release_channels_and_exact_tags(version: str, channel: str) -> None:
    assert release_channel(version) == channel
    validate_tag_version(f"v{version}", version)
    with pytest.raises(ValueError, match="does not match"):
        validate_tag_version(version, version)


@pytest.mark.parametrize(
    "version",
    ["0.02.0", "0.2", "0.2.0b0", "0.2.0rc01", "0.2.0a1", "0.2.0+local"],
)
def test_noncanonical_release_versions_are_rejected(version: str) -> None:
    with pytest.raises(ValueError, match="Invalid release version"):
        validate_version(version)


def test_release_versions_advance_numerically_through_the_preview_channels() -> None:
    ordered = ["0.2.0b2", "0.2.0b10", "0.2.0rc1", "0.2.0", "0.2.1b1"]
    assert sorted(ordered[2:] + ordered[:2], key=version_key) == ordered
    for current, following in pairwise(ordered):
        validate_next_version(current, following)
        with pytest.raises(ValueError, match="must be newer"):
            validate_next_version(following, current)
    with pytest.raises(ValueError, match="must be newer"):
        validate_next_version("0.2.0rc1", "0.2.0rc1")


def test_extracts_exact_candidate_notes_and_orders_the_prepared_versions() -> None:
    markdown = f"""{UNRELEASED}
## [0.2.0] - 2026-11-23 (rc1)

<br>

### ✨ Added

- A beta feature that still ships.

### 🐛 Fixed

- A fix made during candidate testing.

---

## [0.1.9] - 2026-11-15

### 🛠️ Changed

- This belongs to the previous stable release.
"""
    assert latest_release_version(markdown) == "0.2.0rc1"
    assert build_release_notes(markdown, "0.2.0rc1") == (
        "## ✨ Added\n\n"
        "- A beta feature that still ships.\n\n"
        "## 🐛 Fixed\n\n"
        "- A fix made during candidate testing.\n"
    )
    with pytest.raises(ValueError, match="exactly one release heading"):
        build_release_notes(markdown, "0.2.0b1")


def test_release_notes_require_one_cumulative_heading_per_target() -> None:
    markdown = f"""{UNRELEASED}
## [0.2.0] - 2026-11-23 (rc1)

- Candidate notes.

## [0.2.0] - 2026-11-21 (b1)

- Beta notes.
"""
    with pytest.raises(ValueError, match="one cumulative heading"):
        build_release_notes(markdown, "0.2.0rc1")
    with pytest.raises(ValueError, match="Invalid cumulative release heading"):
        build_release_notes(markdown.replace("[0.2.0]", "[0.2.0rc1]", 1), "0.2.0rc1")


def test_only_stable_major_and_minor_releases_belong_in_the_contents() -> None:
    stable = f"{UNRELEASED}\n## [0.2.0] - 2026-11-23\n\n- Stable.\n"
    stable_link = r"1. [\[0.2.0\] - 2026-11-23](#020---2026-11-23)" + "\n"
    with pytest.raises(ValueError, match="table of contents"):
        build_release_notes(stable, "0.2.0")
    assert build_release_notes(stable_link + stable, "0.2.0") == "- Stable.\n"

    preview = stable.replace("2026-11-23\n", "2026-11-23 (b1)\n")
    preview_link = "[Preview](#020---2026-11-23-b1)\n"
    assert build_release_notes(preview, "0.2.0b1") == "- Stable.\n"
    with pytest.raises(ValueError, match="must be omitted"):
        build_release_notes(preview_link + preview, "0.2.0b1")


def test_only_build_rehearsal_accepts_pending_unreleased_notes() -> None:
    markdown = f"{UNRELEASED}\n- Pending.\n\n## [0.2.1] - 2026-11-23\n\n- Ready.\n"
    with pytest.raises(ValueError, match="Move the .* entries"):
        build_release_notes(markdown, "0.2.1")
    assert build_release_notes(markdown, "0.2.1", allow_unreleased_entries=True) == (
        "- Ready.\n"
    )


def test_pushed_tag_and_requested_notes_must_match(tmp_path: Path) -> None:
    destination = tmp_path / "notes.md"
    with pytest.raises(ValueError, match="does not match"):
        main(
            [
                "0.2.0b1",
                "--project-version",
                "0.2.0rc1",
                "--tag",
                "v0.2.0rc1",
                "--output",
                str(destination),
            ]
        )
    assert not destination.exists()
