"""Provision the pinned ColGREP executable, CPU runtime, and local code model."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import tempfile
import zipfile
from pathlib import Path

from ._common import (
    SetupError,
    download,
    extract_archive,
    no_links,
    owned_directory,
    write_json,
)

COLGREP_VERSION = "1.8.5"
_ORT_VERSION = "1.23.0"
_MODEL_REVISION = "4bcdf5ed93f791259eb130b577a240f753d68dd8"
_COLGREP_RELEASE = (
    f"https://github.com/lightonai/next-plaid/releases/download/v{COLGREP_VERSION}"
)
_ORT_PACKAGES = "https://files.pythonhosted.org/packages"
_MODEL_RELEASE = (
    f"https://huggingface.co/lightonai/LateOn-Code-edge/resolve/{_MODEL_REVISION}"
)

# > Archive digests come from the ColGREP release metadata and ONNX Runtime's
# > PyPI release metadata. Only native libraries are copied from the wheels.
_PLATFORMS = {
    ("Linux", "x86_64"): (
        "x86_64-unknown-linux-gnu.tar.xz",
        "532e1da739f6b5d489cdaefd20c5918fa1bb0ff9f456c89098eb49a6379ae205",
        "0b/62/84f23952d01e07ce8aa02e657e3a0c8fa40aba0d5e11a0e9904a9063af76",
        "manylinux_2_27_x86_64.manylinux_2_28_x86_64",
        "05f67edb93678cab5cd77eda89b65bb1b58f3d4c0742058742cfad8b172cfa83",
    ),
    ("Linux", "aarch64"): (
        "aarch64-unknown-linux-gnu.tar.xz",
        "90ccb4132ca34c5202ca3d9789e722446dfed85b3be6247321ee55e1a909f34b",
        "1a/1f/5b76864a970a23dc85f8745d045b81a9151aa101bbb426af6fa489f59364",
        "manylinux_2_27_aarch64.manylinux_2_28_aarch64",
        "974e327ca3b6d43da404b9a45df1f61e2503667fde46843ee7ad1567a98f3f0b",
    ),
    ("Darwin", "arm64"): (
        "aarch64-apple-darwin.tar.xz",
        "2cd013c820a6ba9d4066c58ce7e6b75ea614dd77a9a18a88836e005f1ef126bc",
        "fb/33/ec5395c9539423246e4976d6ec7c4e7a4624ad8bcbe783fea5c629d7980a",
        "macosx_13_0_arm64",
        "5921f2e106f5faf2b32095b2ecdfae047e445c3bce063e439dadc75c212e7be7",
    ),
    ("Darwin", "x86_64"): (
        "x86_64-apple-darwin.tar.xz",
        "6f23777e87a7cee9c31846514bc0a70736df71f201abfff6aedb51dc27ec6c2a",
        "f0/3c/d1976a9933e075291a3d67f4e949c667ff36a3e3a4a0cbd883af3c4eae5a",
        "macosx_13_0_x86_64",
        "053df2f9c6522b258055bce4b776aa9ea3adb4b28d2530ab07b204a3d4b04bf9",
    ),
    ("Windows", "x86_64"): (
        "x86_64-pc-windows-msvc.zip",
        "4f8f240ccbf17740e70d36b798904cf592622719bf11e9c1c86dc01cf9f2c42d",
        "19/90/d5b4ea0bd6805f3f21aac2fe549a5b58ee10d1c99c499d867539620a002b",
        "win_amd64",
        "e100f3869da4c12b17a9b942934a96a542406f860eb8beb74a68342ea43aaa55",
    ),
}
_ORT_FILES = {
    "Linux": (
        f"libonnxruntime.so.{_ORT_VERSION}",
        "libonnxruntime_providers_shared.so",
    ),
    "Darwin": (f"libonnxruntime.{_ORT_VERSION}.dylib",),
    "Windows": ("onnxruntime.dll", "onnxruntime_providers_shared.dll"),
}
_MODEL_FILES = {
    "config.json": "c1413b20ad05927b8226aa2223b3ae104cd04c8541fe1300bdcf455fc8667601",
    "config_sentence_transformers.json": "34942289dec20e285b07132aa1d09980ed776a0bc34e531dd7b49c4701876871",
    "onnx_config.json": "fa4fef89820dcdc33c5504c62c1d5efc19603cfbfebf02368a70d51a4dbe6651",
    "tokenizer.json": "a388b94942e98e5c661c6c23f919842285738bfd123a0d148dea0c56287505d0",
    "model.onnx": "ac5a92a685512b163c3c591438f518379309d2a98c4818a9c6e2986f789dc8ef",
    "model_int8.onnx": "eac35bdaa862e2762e6455337f7a3e704b05dbc4259f00929fcc8e10207f11c7",
}


def _digest(file: Path) -> str:
    with file.open("rb") as contents:
        return hashlib.file_digest(contents, "sha256").hexdigest()


def _ready(
    directory: Path, identity: dict[str, str], relative_files: tuple[str, ...]
) -> bool:
    """Recognize the complete pinned deployment, including repairable file changes."""
    try:
        manifest = directory / "assets.json"
        no_links(manifest)
        record = json.loads(manifest.read_text(encoding="utf-8"))
        if not isinstance(record, dict) or any(
            record.get(key) != value for key, value in identity.items()
        ):
            return False
        hashes = record.get("files")
        if not isinstance(hashes, dict) or set(hashes) != set(relative_files):
            return False
        for relative in relative_files:
            file = directory / relative
            no_links(file)
            if not file.is_file() or _digest(file) != hashes[relative]:
                return False
        return os.access(directory / identity["binary"], os.X_OK) and all(
            hashes[f"model/{name}"] == expected
            for name, expected in _MODEL_FILES.items()
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False


def prepare_colgrep(deployment: Path) -> Path:
    """Prepare verified repository-search assets inside an owned deployment.

    Callers that update the runtime serialize this operation with its setup lock.
    The manifest is published after all pinned files have been placed.

    :param deployment: Absolute LTCook deployment directory.
    :return: ColGREP asset directory containing the manifest.
    :raises SetupError: If the platform or downloaded artifacts are unsuitable.
    """
    system, machine = platform.system(), platform.machine().lower()
    machine = "x86_64" if machine == "amd64" else machine
    spec = _PLATFORMS.get((system, machine))
    if spec is None:
        raise SetupError(f"No pinned ColGREP assets for {system}/{machine}.")

    target = owned_directory(deployment / "colgrep")
    binary = "colgrep.exe" if system == "Windows" else "colgrep"
    ort_files = tuple(f"ort/{name}" for name in _ORT_FILES[system])
    relative_files = (binary, *ort_files, *(f"model/{name}" for name in _MODEL_FILES))
    identity = {
        "colgrepVersion": COLGREP_VERSION,
        "onnxRuntimeVersion": _ORT_VERSION,
        "modelRevision": _MODEL_REVISION,
        "platform": f"{system}/{machine}",
        "binary": binary,
        "library": ort_files[0],
        "model": "model",
    }
    if _ready(target, identity, relative_files):
        return target

    colgrep_name, colgrep_digest, ort_prefix, ort_tag, ort_digest = spec
    ort_name = f"onnxruntime-{_ORT_VERSION}-cp312-cp312-{ort_tag}.whl"
    with tempfile.TemporaryDirectory(prefix="colgrep-stage-", dir=deployment) as temp:
        stage = Path(temp)
        archive = stage / f"colgrep-{colgrep_name}"
        download(f"{_COLGREP_RELEASE}/{archive.name}", archive, colgrep_digest)
        extracted = stage / "extracted"
        extract_archive(archive, extracted)
        matches = [file for file in extracted.rglob(binary) if file.is_file()]
        if len(matches) != 1:
            raise SetupError("Pinned ColGREP archive lacks a unique executable.")
        no_links(matches[0])
        shutil.copyfile(matches[0], stage / binary)
        (stage / binary).chmod(0o700)

        ort_archive = stage / ort_name
        download(f"{_ORT_PACKAGES}/{ort_prefix}/{ort_name}", ort_archive, ort_digest)
        (stage / "ort").mkdir()
        with zipfile.ZipFile(ort_archive) as wheel:
            for name in _ORT_FILES[system]:
                with (
                    wheel.open(f"onnxruntime/capi/{name}") as library,
                    (stage / "ort" / name).open("xb") as output,
                ):
                    shutil.copyfileobj(library, output)

        (stage / "model").mkdir()
        for name, digest in _MODEL_FILES.items():
            download(f"{_MODEL_RELEASE}/{name}", stage / "model" / name, digest)

        hashes = {relative: _digest(stage / relative) for relative in relative_files}
        for relative in relative_files:
            destination = target / relative
            no_links(destination)
            destination.parent.mkdir(mode=0o700, exist_ok=True)
            (stage / relative).replace(destination)
        write_json(target / "assets.json", {**identity, "files": hashes})
    return target
