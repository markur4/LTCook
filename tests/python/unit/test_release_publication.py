"""Exercise verified publication with a local GitHub command fixture."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from test_release_manifest import COMMIT, VERSION, _release_inputs

from ltcook_dev.packaging import release_assets
from ltcook_dev.packaging.release_stage import stage_release

REPOSITORY = "markur4/LTCook"
TAG = f"v{VERSION}"
TAG_OBJECT = "f" * 40


class GitHub:
    """Model GitHub release state without invoking the GitHub CLI."""

    def __init__(self, tag: str = TAG) -> None:
        self.tag = tag
        self.target_commit = COMMIT
        self.releases: dict[int, dict[str, object]] = {}
        self.mutations: list[tuple[str, object]] = []
        self.changed_preview: int | None = None

    def add(
        self,
        number: int,
        tag: str,
        *,
        draft: bool = False,
        preview: bool = False,
        day: int = 1,
        assets: tuple[dict[str, str], ...] = (),
    ) -> None:
        self.releases[number] = {
            "id": number,
            "tag_name": tag,
            "draft": draft,
            "prerelease": preview,
            "published_at": None if draft else f"2026-11-{day:02}T12:00:00Z",
            "assets": list(assets),
        }

    def __call__(self, *args: str) -> str:
        if args[0] == "release":
            action, tag = args[1:3]
            if action == "create":
                assert "--draft" in args and "--verify-tag" in args
                self.add(
                    100,
                    tag,
                    draft=True,
                    preview="--prerelease=true" in args,
                )
                self.mutations.append(("create", tag))
                return ""
            assert action == "upload"
            release = next(
                release
                for release in self.releases.values()
                if release["tag_name"] == tag
            )
            assert release["draft"] is True
            filenames = [Path(name) for name in args[5:]]
            assets = release["assets"]
            assert isinstance(assets, list)
            assets.extend(_asset(path) for path in filenames)
            self.mutations.append(("upload", {path.name for path in filenames}))
            return ""
        assert args[0] == "api"
        if "--paginate" in args:
            return json.dumps([list(self.releases.values())])
        endpoint = args[1]
        if endpoint.endswith(f"/git/ref/tags/{self.tag}"):
            return json.dumps({"object": {"type": "tag", "sha": TAG_OBJECT}})
        if endpoint.endswith(f"/git/tags/{TAG_OBJECT}"):
            return json.dumps(
                {
                    "tag": self.tag,
                    "object": {"type": "commit", "sha": self.target_commit},
                }
            )
        number = int(endpoint.rsplit("/", 1)[1])
        if "DELETE" in args:
            self.mutations.append(("delete", self.releases[number]["tag_name"]))
            del self.releases[number]
            return ""
        release = self.releases[number]
        if "PATCH" in args:
            self.mutations.append(("publish", number))
            assert "draft=false" in args
            assert f"make_latest={str(not release['prerelease']).lower()}" in args
            release["draft"] = False
            release["published_at"] = "2026-11-23T12:00:00Z"
        if number == self.changed_preview:
            return json.dumps({**release, "prerelease": False})
        return json.dumps(release)


def _asset(path: Path) -> dict[str, str]:
    return {
        "name": path.name,
        "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}",
        "state": "uploaded",
    }


@pytest.fixture
def bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    _release_inputs(tmp_path)
    monkeypatch.chdir(tmp_path)
    stage_release(TAG, COMMIT, root=tmp_path, repository=REPOSITORY)
    notes = tmp_path / "notes.md"
    notes.write_text("# Release notes\n", encoding="utf-8")
    return tmp_path / "release/assets", notes


def _publish(bundle: tuple[Path, Path]) -> None:
    directory, notes = bundle
    release_assets.publish(
        directory, repository=REPOSITORY, tag=TAG, commit=COMMIT, notes=notes
    )


def test_verified_stable_bundle_publishes_once_and_retries_unchanged(
    bundle: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    github = GitHub()
    monkeypatch.setattr(release_assets, "_gh", github)
    _publish(bundle)
    assert github.releases[100]["draft"] is False
    assert [action for action, _ in github.mutations] == ["create", "upload", "publish"]
    _publish(bundle)
    assert len(github.mutations) == 3


def test_draft_retry_uploads_only_missing_verified_assets(
    bundle: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    directory, _ = bundle
    paths = sorted(directory.iterdir())
    github = GitHub()
    github.add(1, TAG, draft=True, assets=(_asset(paths[0]),))
    monkeypatch.setattr(release_assets, "_gh", github)
    _publish(bundle)
    assert github.mutations == [
        ("upload", {path.name for path in paths[1:]}),
        ("publish", 1),
    ]


@pytest.mark.parametrize("invalid", ["remote-tag", "draft-digest", "published-missing"])
def test_publication_rejects_divergent_state_before_mutating_github(
    bundle: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch, invalid: str
) -> None:
    directory, _ = bundle
    github = GitHub()
    if invalid == "remote-tag":
        github.target_commit = "0" * 40
        message = "Remote annotated tag"
    elif invalid == "draft-digest":
        asset = _asset(next(directory.iterdir()))
        github.add(1, TAG, draft=True, assets=({**asset, "digest": "sha256:wrong"},))
        message = "conflicts with the bundle"
    else:
        github.add(1, TAG)
        message = "missing expected assets"
    monkeypatch.setattr(release_assets, "_gh", github)
    with pytest.raises(release_assets.ReleaseError, match=message):
        _publish(bundle)
    assert github.mutations == []


def test_verify_rejects_a_setup_with_a_divergent_binding_under_valid_hashes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inputs = _release_inputs(tmp_path, wrong_field="commit")
    monkeypatch.chdir(tmp_path)
    directory = tmp_path / "dist"
    release_assets.stage(
        directory, list(inputs), repository=REPOSITORY, tag=TAG, commit=COMMIT
    )
    with pytest.raises(ValueError, match="identity does not match"):
        release_assets.verify(directory, repository=REPOSITORY, tag=TAG, commit=COMMIT)


@pytest.mark.parametrize(
    ("suffix", "channel", "keep"), [("b", "beta", 1), ("rc", "pre-release", 3)]
)
def test_preview_retention_preserves_other_channels_drafts_and_tags(
    monkeypatch: pytest.MonkeyPatch, suffix: str, channel: str, keep: int
) -> None:
    tag = f"v1.0.0{suffix}4"
    github = GitHub(tag)
    for number in range(1, 5):
        github.add(number, f"v1.0.0{suffix}{number}", preview=True, day=number)
    github.add(5, "v0.9.0")
    other = "rc" if suffix == "b" else "b"
    github.add(6, f"v1.0.0{other}1", preview=True)
    github.add(7, f"v1.0.0{suffix}5", draft=True, preview=True)
    monkeypatch.setattr(release_assets, "_gh", github)

    release_assets._prune_previews(
        release_assets.Identity(REPOSITORY, tag, COMMIT), 4, channel
    )

    assert set(github.releases) == set(range(5 - keep, 8))
    assert github.mutations == [
        ("delete", f"v1.0.0{suffix}{number}") for number in range(4 - keep, 0, -1)
    ]


def test_preview_retention_refuses_a_release_that_changed_after_listing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tag = "v1.0.0b2"
    github = GitHub(tag)
    github.add(1, "v1.0.0b1", preview=True)
    github.add(2, tag, preview=True, day=2)
    github.changed_preview = 1
    monkeypatch.setattr(release_assets, "_gh", github)

    with pytest.raises(release_assets.ReleaseError, match="changed during retention"):
        release_assets._prune_previews(
            release_assets.Identity(REPOSITORY, tag, COMMIT), 2, "beta"
        )

    assert github.mutations == []
