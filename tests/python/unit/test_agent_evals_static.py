from ltcook_dev.agent_evals.__main__ import _audit_static


def test_static_audit_detects_exact_duplicates_and_reports_coverage(
    tmp_path, monkeypatch
):
    root = tmp_path / "runtime" / "resources"
    root.mkdir(parents=True)
    (root / "one.md").write_text("same guidance\n")
    (root / "two.md").write_text("same guidance\n")
    monkeypatch.chdir(tmp_path)

    report = _audit_static()

    assert report["findings"] == [
        {
            "kind": "duplicate",
            "sources": ["runtime/resources/one.md", "runtime/resources/two.md"],
        }
    ]
    assert report["coverage_complete"] is False
    assert report["resource_count"] == 2
    assert report["unique_content_count"] == 1
