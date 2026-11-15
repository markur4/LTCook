from ltcook_dev.ibb.evaluation import DATASET


def test_ibb_dataset_uses_objective_oracle_cases():
    assert DATASET.name == "ltcook-ibb-v1"
    assert [case.name for case in DATASET.cases] == [
        "read-only",
        "no-op",
        "targeted-fix",
    ]


def test_ibb_evaluator_reports_oracle_failures():
    report = DATASET.evaluate_sync(
        lambda inputs: {"oracle_passed": inputs["kind"] != "read-only"},
        progress=False,
    )

    assert report.cases[0].assertions["_success"].value is False
    assert report.cases[1].assertions["_success"].value is True
    assert report.cases[2].assertions["_success"].value is True
