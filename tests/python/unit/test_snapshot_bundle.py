"""Keep compiled payloads intact across SDK cleanup, wheel building, and setup."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from apprc.distribution import build_project_snapshot, read_distribution_spec

from ltcook_dev.packaging.package_assets import (
    REQUIRED_PASEO_PLUGIN_ASSETS,
    archive_assets,
)

ROOT = Path(__file__).resolve().parents[3]


def _committed_project(root: Path) -> str:
    """Commit maintained Python sources without any live generated payload.

    :param root: Private fixture repository, separate from the working checkout.
    :return: Full immutable fixture commit consumed by the SDK exporter.
    """
    root.mkdir()
    for name in ("pyproject.toml", "uv.lock", "README.md", "LICENSE"):
        source = ROOT / name
        if source.is_file():
            shutil.copyfile(source, root / name)
    for package in ("ltcook", "ltcook_distr", "ltcook_dev"):
        shutil.copytree(
            ROOT / "src" / package,
            root / "src" / package,
            ignore=shutil.ignore_patterns(
                "__pycache__", "*.pyc", "bundle", "bundle.zip", "artifacts", "_support"
            ),
        )
    declarations = {
        "package.json": '{"name":"snapshot-fixture","private":true}',
        "package-lock.json": '{"name":"snapshot-fixture","lockfileVersion":3}',
        ".node-version": "26.13.1\n",
        "runtime/package.json": '{"name":"runtime-fixture"}',
        "services/compose.yaml": "services: {}\n",
    }
    for team in ("default", "default-minimal"):
        declarations[f"teams/{team}/package.json"] = '{"name":"' + team + '"}'
        declarations[f"teams/{team}/resources/rules.md"] = f"{team} rules\n"
    for name, content in declarations.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    environment = dict(os.environ)
    for key in tuple(environment):
        if key.startswith("GIT_"):
            environment.pop(key)
    environment.update(
        {
            "GIT_AUTHOR_NAME": "Snapshot fixture",
            "GIT_AUTHOR_EMAIL": "snapshot@example.invalid",
            "GIT_COMMITTER_NAME": "Snapshot fixture",
            "GIT_COMMITTER_EMAIL": "snapshot@example.invalid",
        }
    )
    for arguments in (
        ("init", "--quiet"),
        ("add", "."),
        ("commit", "--quiet", "--no-gpg-sign", "-m", "snapshot fixture"),
    ):
        subprocess.run(
            ["git", "-C", str(root), *arguments],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        env=environment,
        text=True,
    ).strip()


INITIALIZE_WHEEL = r"""
import importlib
import io
import os
import sys
import tarfile
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch

wheel, appdata = map(Path, sys.argv[1:])
sys.path.insert(0, str(wheel))
from apprc.definition.installation import InstallationPlacement, OperationContext
from apprc.definition.paths import Layout
from ltcook_distr.payload.app_lifecycle import actions
runtime = importlib.import_module('ltcook_distr.payload.app_lifecycle.prepare_runtime')
assert actions.__file__.startswith(str(wheel)), actions.__file__

def download_node(url, destination):
    basename = destination.name.removesuffix('.tar.gz')
    with tarfile.open(destination, 'w:gz') as archive:
        for name in ('node', 'npm'):
            data = b'fixture external executable\n'
            member = tarfile.TarInfo(f'{basename}/bin/{name}')
            member.size = len(data)
            member.mode = 0o755
            archive.addfile(member, io.BytesIO(data))

def install_dependencies(arguments, *, environment, cwd=None, required=True):
    assert cwd is not None
    assert arguments[1:] == ['ci', '--omit=dev', '--no-audit', '--no-fund']
    (cwd / 'node_modules').mkdir()

context = OperationContext(
    appdata.parent / 'authority', uuid4(), uuid4(),
    InstallationPlacement(Layout(), appdata_dir=appdata, capabilities=frozenset({'appdata'})),
)
with patch.dict(os.environ, {'LTCOOK_BROWSER_ENABLED': 'false', 'LTCOOK_SERVICE_CONNECTION': 'direct'}):
    with patch.object(runtime, 'download', download_node), patch.object(runtime, 'run', install_dependencies):
        actions.initialize(context)
        actions.initialize(context)
"""


@pytest.mark.skipif(sys.platform != "linux", reason="Linux native payload contract.")
def test_finished_snapshot_wheel_initializes_compiled_assets(tmp_path: Path) -> None:
    """Exercise the final SDK snapshot rather than the pre-cleanup export tree.

    :param tmp_path: Isolated repository, package build, and deployment workspace.
    """
    source = tmp_path / "project"
    commit = _committed_project(source)
    expected = {
        "runtime/dist/main.js": "export const runtime = 'snapshot-runtime';\n",
        "runtime/dist/team-api/index.js": "export const teamApiVersion = 2;\n",
        "runtime/dist/guidance-api/index.js": "export const guidance = true;\n",
        "runtime/dist/workflow-api/index.js": "export const workflow = true;\n",
        "runtime/src/team-api/index.ts": "export interface TeamPackage {}\n",
        "runtime/src/guidance-api/index.ts": "export interface GuidanceResource {}\n",
        "runtime/src/workflow-api/index.ts": "export interface PlanningRecord {}\n",
        "runtime/src/workflow-api/commands.ts": "export type RuntimeCommand = never;\n",
        "runtime/resources/rules/planning.md": "Required planning rule\n",
        "runtime/resources/skills/ltcook-planning/SKILL.md": "Planning skill\n",
        "runtime/dist/integrations/pi-rpc.js": "// snapshot Pi RPC\n",
        "runtime/dist/paseo-plugin/paseo-plugin.json": '{"id":"snapshot-plugin"}',
        "runtime/dist/paseo-plugin/index.server.ts": "// snapshot server plugin\n",
        "runtime/dist/paseo-plugin/index.client.tsx": "// snapshot client plugin\n",
        "teams/default/dist/index.js": "export const team = 'default';\n",
        "teams/default-minimal/dist/index.js": "export const team = 'default-minimal';\n",
        "teams/default/resources/rules.md": "default rules\n",
        "teams/default-minimal/resources/rules.md": "default-minimal rules\n",
        "services/compose.yaml": "services: {}\n",
    }

    def prepare(exported: Path) -> None:
        for asset in REQUIRED_PASEO_PLUGIN_ASSETS:
            name = f"runtime/dist/paseo-plugin/{asset}"
            target = exported / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                expected.get(name, "// snapshot plugin resource\n"), encoding="utf-8"
            )
        for name, content in expected.items():
            target = exported / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        archive_assets(
            exported,
            exported / "src/ltcook_distr/bundle.zip",
            staging_parent=tmp_path,
        )

    project = build_project_snapshot(
        read_distribution_spec(source),
        revision=commit,
        destination=tmp_path / "snapshot.zip",
        prepare=prepare,
    )
    assert project.source.commit == commit
    finished = tmp_path / "finished"
    with zipfile.ZipFile(project.archive) as snapshot:
        assert "src/ltcook_distr/bundle.zip" in snapshot.namelist()
        assert not any("dist" in Path(name).parts for name in snapshot.namelist())
        snapshot.extractall(finished)
    wheel_directory = tmp_path / "wheels"
    wheel_directory.mkdir()
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    build = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from setuptools.build_meta import build_wheel; "
                "import sys; build_wheel(sys.argv[1])"
            ),
            str(wheel_directory),
        ],
        cwd=finished,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert build.returncode == 0, build.stdout + build.stderr
    wheels = tuple(wheel_directory.glob("*.whl"))
    assert len(wheels) == 1
    with zipfile.ZipFile(wheels[0]) as wheel:
        assert "ltcook_distr/bundle.zip" in wheel.namelist()
        assert not any(
            name.startswith("ltcook_distr/bundle/") for name in wheel.namelist()
        )
    appdata = tmp_path / "appdata"
    appdata.mkdir()
    initialized = subprocess.run(
        [sys.executable, "-I", "-c", INITIALIZE_WHEEL, str(wheels[0]), str(appdata)],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert initialized.returncode == 0, initialized.stdout + initialized.stderr
    deployment = appdata / "deployment"
    for name, content in expected.items():
        assert (deployment / "app" / name).read_text(encoding="utf-8") == content
    runtime = json.loads((deployment / "runtime.json").read_text(encoding="utf-8"))
    services = json.loads((deployment / "services.json").read_text(encoding="utf-8"))
    assert runtime["node_version"] == "26.13.1"
    assert runtime["browser_available"] is False
    assert services["connection"] == "direct"
