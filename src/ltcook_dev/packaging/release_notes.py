"""Build GitHub Release notes from the curated changelog."""

from __future__ import annotations

import argparse
import re
from collections.abc import Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
_BASE_VERSION = r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}"
_PREVIEW = r"(?:b|rc)[1-9][0-9]*"
VERSION_RE = re.compile(
    rf"(?P<base>{_BASE_VERSION})(?:(?P<phase>b|rc)(?P<serial>[1-9][0-9]*))?"
)
RELEASE_HEADING_RE = re.compile(
    rf"^## \[(?P<version>{_BASE_VERSION})\] - "
    rf"(?P<date>\d{{4}}-\d{{2}}-\d{{2}})(?: \((?P<preview>{_PREVIEW})\))?"
    r"(?P<yanked> \[YANKED\])?$",
    re.MULTILINE,
)
UNRELEASED_HEADING = "## [Unreleased]"
UNRELEASED_SECTIONS = (
    "### ✨ Added",
    "### 🛠️ Changed",
    "### 🗑️ Deprecated",
    "### 🔥 Removed",
    "### 🐛 Fixed",
    "### 🔒 Security",
)


def build_release_notes(
    markdown: str, version: str, *, allow_unreleased_entries: bool = False
) -> str:
    """Extract one released changelog section for a GitHub Release.

    :param markdown: Complete changelog text.
    :param version: Released semantic version without a leading ``v``.
    :param allow_unreleased_entries: Whether build-only extraction may tolerate
        entries still present under ``[Unreleased]``.
    :return: GitHub Release body.
    """
    validate_version(version)
    match = _release_heading(markdown, version)
    validate_unreleased_section(markdown, allow_entries=allow_unreleased_entries)
    _validate_toc_entry(markdown, match)
    next_heading = re.search(r"^## \[", markdown[match.end() :], re.MULTILINE)
    section_end = (
        match.end() + next_heading.start()
        if next_heading is not None
        else len(markdown)
    )
    notes = _clean_release_markdown(markdown[match.end() : section_end])
    if not any(line.lstrip().startswith("- ") for line in notes.splitlines()):
        raise ValueError(f"Release {version} has no changelog entries.")
    return f"{notes}\n"


def validate_version(version: str) -> None:
    """Require a canonical stable, beta, or release candidate version.

    :param version: Candidate version without a leading ``v``.
    :return: None.
    """
    _version_match(version)


def _version_match(version: str) -> re.Match[str]:
    match = VERSION_RE.fullmatch(version)
    if match is None:
        raise ValueError(
            f"Invalid release version {version!r}. Expected MAJOR.MINOR.PATCH "
            "with an optional bN or rcN suffix."
        )
    return match


def version_key(version: str) -> tuple[int, int, int, int, int]:
    """Order canonical versions by numeric target, release channel, and serial."""
    match = _version_match(version)
    major, minor, patch = (int(part) for part in match["base"].split("."))
    phase = {"b": 0, "rc": 1, None: 2}[match["phase"]]
    return major, minor, patch, phase, int(match["serial"] or 0)


def release_channel(version: str) -> str:
    """Return the publication channel for a canonical project version."""
    return ("beta", "pre-release", "stable")[version_key(version)[3]]


def validate_tag_version(tag: str, project_version: str) -> None:
    """Require a pushed tag to name the checked-out project version.

    :param tag: Canonical project version prefixed with ``v``.
    :param project_version: Version read from project metadata.
    :return: None.
    """
    validate_version(project_version)
    expected_tag = f"v{project_version}"
    if tag != expected_tag:
        raise ValueError(
            f"Release tag {tag!r} does not match project version "
            f"{project_version!r}; expected {expected_tag!r}."
        )


def validate_next_version(current_version: str, next_version: str) -> None:
    """Require a prepared changelog release to advance project metadata.

    :param current_version: Version currently stored in project metadata.
    :param next_version: Version prepared in the changelog for release.
    :return: None.
    """
    if version_key(next_version) <= version_key(current_version):
        raise ValueError(
            f"Prepared release {next_version!r} must be newer than the "
            f"current project version {current_version!r}."
        )


def latest_release_version(markdown: str) -> str:
    """Return the highest released version declared in a changelog.

    :param markdown: Complete changelog text.
    :return: Highest released semantic version.
    """
    matches = _release_headings(markdown)
    if not matches:
        raise ValueError("Changelog has no versioned release heading.")
    return max((_heading_version(match) for match in matches), key=version_key)


def validate_unreleased_section(markdown: str, *, allow_entries: bool = False) -> None:
    """Require one complete ``[Unreleased]`` template and, by default, no entries.

    :param markdown: Complete changelog text.
    :param allow_entries: Whether build-only note extraction may tolerate entries.
    :return: None.
    """
    headings = list(
        re.finditer(rf"^{re.escape(UNRELEASED_HEADING)}$", markdown, re.MULTILINE)
    )
    if len(headings) != 1:
        raise ValueError("Changelog must contain exactly one [Unreleased] heading.")
    start = headings[0].end()
    next_release = RELEASE_HEADING_RE.search(markdown, start)
    if next_release is None:
        raise ValueError("Changelog has no released section after [Unreleased].")
    section = markdown[start : next_release.start()]
    content = _content_lines(section)
    categories = tuple(line for line in content if line.startswith("### "))
    if categories != UNRELEASED_SECTIONS:
        raise ValueError(
            "The [Unreleased] section must contain the six release categories in order."
        )
    if not allow_entries and any(line not in categories for line in content):
        raise ValueError(
            "Move the [Unreleased] entries into the prepared version before tagging."
        )


def write_release_notes(
    markdown: str,
    version: str,
    output: Path,
    *,
    allow_unreleased_entries: bool = False,
) -> None:
    """Write extracted release notes to a workflow artifact path.

    :param markdown: Complete changelog text.
    :param version: Released semantic version without a leading ``v``.
    :param output: Destination Markdown file.
    :param allow_unreleased_entries: Whether build-only extraction may tolerate
        entries still present under ``[Unreleased]``.
    :return: None.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        build_release_notes(
            markdown, version, allow_unreleased_entries=allow_unreleased_entries
        ),
        encoding="utf-8",
    )


def _release_headings(markdown: str) -> list[re.Match[str]]:
    headings = []
    for candidate in re.finditer(r"^## \[[0-9].*$", markdown, re.MULTILINE):
        match = RELEASE_HEADING_RE.fullmatch(markdown, *candidate.span())
        if match is None:
            raise ValueError(f"Invalid cumulative release heading {candidate[0]!r}.")
        headings.append(match)
    return headings


def _heading_version(match: re.Match[str]) -> str:
    return match["version"] + (match["preview"] or "")


def _release_heading(markdown: str, version: str) -> re.Match[str]:
    """Return the unique heading for one released version."""
    headings = _release_headings(markdown)
    matches = [match for match in headings if _heading_version(match) == version]
    if len(matches) != 1:
        raise ValueError(
            f"Changelog must contain exactly one release heading for {version}; "
            f"found {len(matches)}."
        )
    match = matches[0]
    target = match["version"]
    if sum(heading["version"] == target for heading in headings) != 1:
        raise ValueError(f"Changelog must use one cumulative heading for {target}.")
    return match


def _validate_toc_entry(markdown: str, match: re.Match[str]) -> None:
    """Require a TOC entry for stable major and minor releases."""
    version, date = match["version"], match["date"]
    preview, yanked = match["preview"], match["yanked"] or ""
    anchor = f"#{version.replace('.', '')}---{date}"
    if preview:
        anchor += f"-{preview}"
    if yanked:
        anchor += "-yanked"
    stage = f" ({preview})" if preview else ""
    entry = rf"[\[{version}\] - {date}{stage}{yanked}]({anchor})"
    toc = f"\n{markdown}".partition(f"\n{UNRELEASED_HEADING}\n")[0]
    if preview is None and version.endswith(".0"):
        if toc.count(entry) == 1:
            return
        raise ValueError(
            f"Changelog table of contents must contain exactly one {entry!r} entry."
        )
    if f"]({anchor})" in toc:
        raise ValueError(
            f"Patch or preview release {_heading_version(match)} must be omitted "
            "from the changelog table of contents."
        )


def _clean_release_markdown(section: str) -> str:
    """Remove changelog layout markers and compact blank lines."""
    cleaned: list[str] = []
    previous_blank = True
    for line in section.splitlines():
        stripped = line.strip()
        if _is_layout_line(stripped):
            continue
        if line.startswith("### "):
            line = line[1:]
        if not stripped:
            if not previous_blank:
                cleaned.append("")
            previous_blank = True
            continue
        cleaned.append(line)
        previous_blank = False
    while cleaned and not cleaned[-1]:
        cleaned.pop()
    return "\n".join(cleaned)


def _content_lines(section: str) -> list[str]:
    """Return non-layout, non-empty lines from one changelog section."""
    return [
        line.strip()
        for line in section.splitlines()
        if line.strip() and not _is_layout_line(line.strip())
    ]


def _is_layout_line(line: str) -> bool:
    """Return whether one line exists only for changelog page layout."""
    return (
        line == "<br>"
        or line == "---"
        or (line.startswith("<!--") and line.endswith("-->"))
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse release-note command arguments.

    :param argv: Optional argument vector used by tests.
    :return: Parsed command namespace.
    """
    parser = argparse.ArgumentParser(
        description="Extract one GitHub Release body from CHANGELOG.md."
    )
    parser.add_argument("version", help="Release version without a leading v.")
    parser.add_argument(
        "--changelog",
        type=Path,
        default=ROOT / "CHANGELOG.md",
        help="Changelog source path.",
    )
    parser.add_argument("--output", type=Path, required=True, help="Destination path.")
    parser.add_argument("--tag", help="Optional pushed tag to validate.")
    parser.add_argument("--project-version", help="Project version to validate.")
    parser.add_argument(
        "--allow-unreleased-entries",
        action="store_true",
        help="Allow unprepared entries for build-only release-note inputs.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Validate release state and write GitHub Release notes.

    :param argv: Optional argument vector used by tests.
    :return: Process exit code.
    """
    args = parse_args(argv)
    if args.tag is not None:
        project_version = args.project_version
        if project_version is None:
            raise ValueError("--tag requires --project-version.")
        validate_tag_version(args.tag, project_version)
        validate_tag_version(args.tag, args.version)
    write_release_notes(
        args.changelog.read_text(encoding="utf-8"),
        args.version,
        args.output,
        allow_unreleased_entries=(args.allow_unreleased_entries and args.tag is None),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
