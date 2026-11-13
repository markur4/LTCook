"""Package consumers reject unsafe archives before staging their bytes."""

import io
import tarfile
import zipfile

import pytest

from ltcook_dev.packaging.package_validation import validate_package


@pytest.mark.parametrize("kind", ["wheel", "source"])
def test_package_identity_matches_expected_distribution(tmp_path, kind):
    metadata = b"Metadata-Version: 2.1\nName: ltcook\nVersion: 0.1.0\n\n"
    if kind == "wheel":
        package = tmp_path / "ltcook-0.1.0-py3-none-any.whl"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("ltcook-0.1.0.dist-info/METADATA", metadata)
    else:
        package = tmp_path / "ltcook-0.1.0.tar.gz"
        with tarfile.open(package, "w:gz") as archive:
            member = tarfile.TarInfo("ltcook-0.1.0/PKG-INFO")
            member.size = len(metadata)
            archive.addfile(member, io.BytesIO(metadata))

    assert validate_package(package, "ltcook", "0.1.0") == package.read_bytes()
    with pytest.raises(ValueError, match="does not match"):
        validate_package(package, "another-project", "0.1.0")
    with pytest.raises(ValueError, match="does not match"):
        validate_package(package, "ltcook", "0.2.0")


@pytest.mark.parametrize("member", ["../outside.py", "/absolute.py", "C:/drive.py"])
def test_wheel_rejects_unsafe_members_before_use(tmp_path, member):
    package = tmp_path / "ltcook-0.1.0-py3-none-any.whl"
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr(member, "untrusted payload")
        archive.writestr(
            "ltcook-0.1.0.dist-info/METADATA",
            "Name: ltcook\nVersion: 0.1.0\n\n",
        )

    with pytest.raises(ValueError, match="Unsafe archive member"):
        validate_package(package, "ltcook", "0.1.0")


def test_source_archive_rejects_links(tmp_path):
    package = tmp_path / "ltcook-0.1.0.tar.gz"
    with tarfile.open(package, "w:gz") as archive:
        member = tarfile.TarInfo("ltcook-0.1.0/link")
        member.type = tarfile.SYMTYPE
        member.linkname = "outside"
        archive.addfile(member)

    with pytest.raises(ValueError, match="contains a link or special file"):
        validate_package(package, "ltcook", "0.1.0")
