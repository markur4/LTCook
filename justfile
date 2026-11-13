set shell := ["bash", "-euo", "pipefail", "-c"]

RELEASE_PYPI := "false"
export RELEASE_REPOSITORY := "markur4/LTCook"
BUN := env_var_or_default("BUN", "bun")

[group('General')]
default:
    @just --list

[group('Runtime')]
mod runtime 'runtime/justfile'

[group('Environment')]
sync:
    {{quote(BUN)}} install --frozen-lockfile
    {{quote(BUN)}} run build
    uv sync --locked --all-groups --no-install-project
    PYTHONPATH=src uv run --locked --no-sync python -m ltcook_dev.packaging.package_assets --root . --destination src/ltcook_distr/bundle
    uv sync --locked --all-groups

[group('Checks')]
check:
    {{quote(BUN)}} run check
    uv run --locked ruff check src tests
    uv run --locked pyright

[group('Checks')]
test:
    {{quote(BUN)}} run test
    uv run --locked pytest -m 'not integration and not system'

[group('Checks')]
test-integration:
    uv run --locked pytest -m integration
    {{quote(BUN)}} run test:integration

[group('Checks')]
test-system:
    uv run --locked pytest -m system

[group('Build')]
build:
    {{quote(BUN)}} run build
    uv sync --locked --all-groups --no-install-project
    PYTHONPATH=src uv run --locked --no-sync python -m ltcook_dev.packaging.package_assets --root . --destination src/ltcook_distr/bundle
    uv build --no-sources --no-build-logs

[group('Build')]
make-artifacts:
    PYTHONPATH=src uv run --locked python -m ltcook_distr.make_artifacts

[group('Build')]
check-artifacts:
    PYTHONPATH=src uv run --locked python -m ltcook_distr.make_artifacts --check
