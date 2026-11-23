# ===============================================================
# Justfile for Python projects using uv + pyproject.toml
# ===============================================================
# Why this exists:
# - One command to install exactly what's in uv.lock (safe for CI).
# - A clear, explicit path to re-lock/upgrade when you WANT changes.
# - Optional exports for the "I only understand requirements.txt" crowd.
#
# References (summarized):
# - uv auto-locks by default; --locked disables that and errors if stale.
# - uv can export a requirements.txt-style file and can also "compile" one.
#   See: uv concepts: lock/sync, uv export, uv pip compile.
#
# Dependencies: uv (and optionally direnv). Python itself is handled by uv.
# ===============================================================

# Let recipes use Bash features and fail-fast in pipelines
set shell := ["bash", "-euo", "pipefail", "-c"]

# Keep publication and hosted CI gates independent in the committed policy.
RELEASE_PYPI := "false"
RELEASE_REQUIRE_CI := "false"
export RELEASE_REPOSITORY := "markur4/LTCook"

BUN := env_var_or_default("BUN", "bun")
export UV_PROJECT_ENVIRONMENT := env_var_or_default("UV_PROJECT_ENVIRONMENT", justfile_directory() + "/.venv")

[group('Runtime')]
mod runtime 'runtime/justfile'

[group('Agent Evals')]
mod eval 'evals/justfile'

# Run `just` with no recipe to list tasks
default:
    @just --list

# ---------------------------------------------------------------
# Optional Git worktree workflows
# ---------------------------------------------------------------

# Create a linked checkout from a frozen commit and sync its own environment.
# Pass recipe values as arguments instead of inserting them into shell source.
[positional-arguments]
worktree-create branch destination base:
    #!/usr/bin/env bash
    set -euo pipefail

    branch="$1"
    destination_input="$2"
    base="$3"

    if ! git check-ref-format --branch "$branch" >/dev/null 2>&1 || ! git check-ref-format "refs/heads/${branch}" >/dev/null 2>&1; then
        echo "Invalid Git branch name." >&2
        exit 2
    fi
    branch_ref="refs/heads/${branch}"
    if git show-ref --verify --quiet "$branch_ref"; then
        echo "That local branch already exists." >&2
        exit 2
    else
        show_ref_status=$?
        if [[ "$show_ref_status" -ne 1 ]]; then
            echo "Could not check whether the branch exists." >&2
            exit "$show_ref_status"
        fi
    fi

    if ! base_commit="$(git rev-parse --verify --end-of-options "${base}^{commit}" 2>/dev/null)"; then
        echo "Base must resolve to a Git commit." >&2
        exit 2
    fi
    if [[ ! "$base_commit" =~ ^[0-9a-f]{40,64}$ ]]; then
        echo "Resolved base is not an immutable Git commit SHA." >&2
        exit 2
    fi

    if [[ -z "$destination_input" || "$destination_input" == *$'\n'* || "$destination_input" == *$'\r'* ]]; then
        echo "Destination must be a non-empty path without line breaks." >&2
        exit 2
    fi
    project_root="$(git rev-parse --show-toplevel)"
    project_root="$(cd -- "$project_root" && pwd -P)"
    case "$destination_input" in
        /*) requested_path="$destination_input" ;;
        *) requested_path="$project_root/$destination_input" ;;
    esac
    destination_name="$(basename "$requested_path")"
    destination_parent="$(dirname "$requested_path")"
    if [[ "$destination_name" == "." || "$destination_name" == ".." || "$destination_name" == "/" ]]; then
        echo "Destination must name a new directory." >&2
        exit 2
    fi
    if [[ ! -d "$destination_parent" ]]; then
        echo "Destination parent directory must already exist." >&2
        exit 2
    fi
    destination_parent="$(cd -- "$destination_parent" && pwd -P)"
    if [[ "$destination_parent" == "/" ]]; then
        destination_path="/$destination_name"
    else
        destination_path="$destination_parent/$destination_name"
    fi
    if [[ -e "$destination_path" || -L "$destination_path" ]]; then
        echo "Destination already exists." >&2
        exit 2
    fi

    while IFS= read -r -d '' record; do
        case "$record" in
            "worktree "*)
                existing_path="${record#worktree }"
                if [[ -d "$existing_path" ]]; then
                    existing_path="$(cd -- "$existing_path" && pwd -P)"
                    if [[ "$destination_path" == "$existing_path" || "$destination_path" == "$existing_path/"* ]]; then
                        echo "Destination must be outside every existing Git worktree." >&2
                        exit 2
                    fi
                fi
                ;;
        esac
    done < <(git worktree list --porcelain -z)

    if ! git worktree add -b "$branch" -- "$destination_path" "$base_commit"; then
        echo "Could not create the Git worktree." >&2
        exit 1
    fi
    echo "Created worktree at $destination_path from $base_commit."

    if (
        cd -- "$destination_path"
        export UV_PROJECT_ENVIRONMENT="$destination_path/.venv"
        just sync
    ); then
        echo "Dependencies synced in $destination_path/.venv."
    else
        sync_status=$?
        printf 'Dependency setup failed; retained worktree for inspection: %s\n' "$destination_path" >&2
        exit "$sync_status"
    fi

# Remove one selected linked checkout after checking its state and merge status.
# Pass recipe values as arguments instead of inserting them into shell source.
[positional-arguments]
worktree-remove destination delete_branch="false":
    #!/usr/bin/env bash
    set -euo pipefail

    destination_input="$1"
    delete_branch="${2:-false}"
    if [[ "$delete_branch" != "true" && "$delete_branch" != "false" ]]; then
        echo "delete_branch must be true or false." >&2
        exit 2
    fi
    if [[ -z "$destination_input" || "$destination_input" == *$'\n'* || "$destination_input" == *$'\r'* ]]; then
        echo "Destination must be a non-empty path without line breaks." >&2
        exit 2
    fi
    project_root="$(git rev-parse --show-toplevel)"
    project_root="$(cd -- "$project_root" && pwd -P)"
    case "$destination_input" in
        /*) requested_path="$destination_input" ;;
        *) requested_path="$project_root/$destination_input" ;;
    esac
    if [[ ! -d "$requested_path" ]]; then
        echo "Destination must be an existing Git worktree directory." >&2
        exit 2
    fi
    destination_path="$(cd -- "$requested_path" && pwd -P)"
    current_worktree="$(cd -- "$(git rev-parse --show-toplevel)" && pwd -P)"

    main_worktree=""
    selected_worktree=""
    selected_branch_ref=""
    entry_path=""
    entry_branch_ref=""
    worktree_count=0
    nested_worktree=false
    record_worktree() {
        if [[ -z "$entry_path" ]]; then
            return
        fi
        worktree_count=$((worktree_count + 1))
        if [[ -d "$entry_path" ]]; then
            entry_real="$(cd -- "$entry_path" && pwd -P)"
        else
            entry_real="$entry_path"
        fi
        if [[ "$entry_real" != "$destination_path" && ( "$entry_real" == "$destination_path/"* || "$destination_path" == "$entry_real/"* ) ]]; then
            nested_worktree=true
        fi
        if [[ "$worktree_count" -eq 1 ]]; then
            main_worktree="$entry_real"
        fi
        if [[ "$entry_real" == "$destination_path" ]]; then
            selected_worktree="$entry_path"
            selected_branch_ref="$entry_branch_ref"
        fi
    }
    while IFS= read -r -d '' record; do
        case "$record" in
            "worktree "*) entry_path="${record#worktree }" ;;
            "branch "*) entry_branch_ref="${record#branch }" ;;
            "")
                record_worktree
                entry_path=""
                entry_branch_ref=""
                ;;
        esac
    done < <(git worktree list --porcelain -z)
    record_worktree

    if [[ -z "$selected_worktree" ]]; then
        echo "Destination is not a registered Git worktree." >&2
        exit 2
    fi
    if [[ "$destination_path" == "$main_worktree" ]]; then
        echo "Refusing to remove the main worktree." >&2
        exit 2
    fi
    if [[ "$destination_path" == "$current_worktree" ]]; then
        echo "Refusing to remove the current worktree." >&2
        exit 2
    fi
    if [[ "$nested_worktree" == "true" ]]; then
        echo "Refusing to remove nested Git worktrees." >&2
        exit 2
    fi
    if [[ -z "$selected_branch_ref" || "$selected_branch_ref" != refs/heads/* ]]; then
        echo "Refusing to remove a detached worktree without a branch to verify." >&2
        exit 2
    fi
    if [[ "$selected_branch_ref" == "refs/heads/main" ]]; then
        echo "Refusing to remove the main branch worktree." >&2
        exit 2
    fi

    worktree_status="$(git -C "$selected_worktree" status --porcelain --untracked-files=all)"
    if [[ -n "$worktree_status" ]]; then
        echo "Refusing to remove a dirty worktree; commit or remove its changes first." >&2
        exit 2
    fi
    if ! main_commit="$(git rev-parse --verify --end-of-options 'refs/heads/main^{commit}' 2>/dev/null)"; then
        echo "Cannot verify the branch because local main does not resolve to a commit." >&2
        exit 2
    fi
    if ! git merge-base --is-ancestor "$selected_branch_ref" "$main_commit"; then
        echo "Refusing to remove a branch that is not merged into local main." >&2
        exit 2
    fi

    selected_branch="${selected_branch_ref#refs/heads/}"
    git worktree remove -- "$selected_worktree"
    if [[ "$delete_branch" == "true" ]]; then
        git branch -d -- "$selected_branch"
        echo "Removed worktree and its merged branch $selected_branch."
    else
        echo "Removed worktree and kept branch $selected_branch."
    fi

# ---------------------------------------------------------------
# Internal guards (kept private so they don't clutter `just --list`)
# ---------------------------------------------------------------
[private]
_note-direnv:
    @if command -v direnv >/dev/null; then \
        test -n "${VIRTUAL_ENV-}" || echo "ℹ direnv detected but VIRTUAL_ENV not active. Run: direnv allow && direnv reload"; \
    fi

[private]
_check-uv:
    : ${UV_PROJECT_ENVIRONMENT:="$PWD/.venv"}
    @command -v uv >/dev/null || { \
        echo "✗ uv not found. Install from https://docs.astral.sh/uv/ then retry." >&2; \
        exit 127; \
    }

[private]
_check-gh:
    @command -v gh >/dev/null || { \
        echo "gh not found. Install it from https://cli.github.com/ and retry." >&2; \
        exit 127; \
    }
    @gh auth status >/dev/null 2>&1 || { \
        echo "gh is not authenticated. Run 'gh auth login' and retry." >&2; \
        exit 1; \
    }

[private]
_committed-release-policy ref setting:
    #!/usr/bin/env bash
    set -euo pipefail
    ref={{quote(ref)}}
    setting={{quote(setting)}}
    case "$setting" in RELEASE_PYPI|RELEASE_REQUIRE_CI) ;; *) exit 2 ;; esac
    if [[ "$ref" == "HEAD" ]]; then
        policy_commit="$(git rev-parse --verify --end-of-options 'HEAD^{commit}')"
    else
        tag_ref="refs/tags/${ref}"
        if ! git check-ref-format "$tag_ref" >/dev/null; then
            echo "Invalid exact release tag ref ${tag_ref}." >&2
            exit 1
        fi
        if ! policy_commit="$(git rev-parse --verify --end-of-options "${tag_ref}^{commit}" 2>/dev/null)"; then
            echo "Could not resolve exact release tag ref ${tag_ref} to a commit." >&2
            exit 1
        fi
    fi
    if [[ ! "$policy_commit" =~ ^[0-9a-f]{40,64}$ ]]; then
        echo "Resolved release policy target is not an immutable commit SHA." >&2
        exit 1
    fi
    if ! source="$(git show "$policy_commit:justfile")"; then
        echo "Could not read justfile from commit $policy_commit." >&2
        exit 1
    fi
    mapfile -t definitions < <(grep -E "^$setting[[:blank:]]*:=" <<< "$source")
    literal="^$setting[[:blank:]]*:=[[:blank:]]*\"(true|false)\"[[:blank:]]*$"
    if (( ${#definitions[@]} != 1 )) || [[ ! "${definitions[0]}" =~ $literal ]]; then
        echo "$setting must be declared once as a true or false literal in commit $policy_commit." >&2
        exit 1
    fi
    printf '%s\n' "${BASH_REMATCH[1]}"

[private]
_check-clean-worktree action="publishing":
    @git diff --quiet || { \
        echo "Unstaged changes exist. Commit or stash before {{action}}." >&2; \
        exit 1; \
    }
    @git diff --cached --quiet || { \
        echo "Staged changes exist. Commit before {{action}}." >&2; \
        exit 1; \
    }
    @test -z "$(git ls-files --others --exclude-standard)" || { \
        echo "Untracked files exist. Commit, ignore, or remove them before {{action}}:" >&2; \
        git ls-files --others --exclude-standard >&2; \
        exit 1; \
    }

# ---------------------------------------------------------------
# Clean / environment helpers
# ---------------------------------------------------------------

# Remove project-local build artifacts and caches without touching the environment.
clean:
    @echo "🧹 Cleaning caches and build artifacts..."
    find src tests \( -name .venv -o -name node_modules -o -name .git \) -prune -o -type d -name "__pycache__" -prune -exec rm -rf {} +
    rm -rf __pycache__ .pytest_cache .mypy_cache .ruff_cache dist build *.egg-info

# Prune uv's global shared cache only when explicitly requested.
clean-uv-cache:
    uv cache prune -y


# Rebuilds python venv from uv.lock
reset-venv:
    uv venv --seed --clear "$UV_PROJECT_ENVIRONMENT"
    just sync

# ---------------------------------------------------------------
# Install flows
# ---------------------------------------------------------------
# Key rule: CI and teammates should *not* relock by accident.
# We therefore install with `--locked` which errors if uv.lock is stale.
# If it errors, you intentionally run `just lock` or `just upgrade`.
# > --all-extras: Install all published extras from [project.optional-dependencies], such as rag.
# > --all-groups: Install all local groups from [dependency-groups], such as dev.
# > --no-default-groups: Skip uv's default groups, including dev, for runtime-only installs.
# > --frozen: Sync from uv.lock while ignoring pyproject.toml
# > --locked: Exit non-zero if pyproject.toml differs from uv.lock


# Install or sync everything from uv.lock into venv. (CI should use this)
# `python -m pip install -e ".[<all_extras>]" --group dev`
sync:
    just _note-direnv
    just _check-uv
    test -d "$UV_PROJECT_ENVIRONMENT" || uv venv "$UV_PROJECT_ENVIRONMENT"
    {{quote(BUN)}} install --frozen-lockfile
    {{quote(BUN)}} run build
    uv sync --locked --all-extras --all-groups --no-install-project
    PYTHONPATH=src uv run --locked --no-sync python -m ltcook_dev.packaging.package_assets --root . --destination src/ltcook_distr/bundle.zip
    uv sync --locked --all-extras --all-groups
alias install := sync

# ---------------------------------------------------------------
# Locking and upgrading
# ---------------------------------------------------------------
# Examples:
#   just lock                   # resolve using current constraints
#   just lock --upgrade         # allow upgrades while resolving
#   just lock --python 3.12     # resolve for a specific interpreter

# Creates uv.lock based on pyproject.toml and exports pylock.toml.
lock *ARGS:
    just _check-uv
    uv lock {{ARGS}}
    uv export -o pylock.toml --all-extras --all-groups --quiet

# Re-lock with --upgrade & install from the new lock.
upgrade *ARGS:
    just lock --upgrade {{ARGS}}
    just sync


# Re-lock with --upgrade ONLY git-based dependencies & uv sync from the new lock.
[positional-arguments]
upgrade-repos *ARGS:
    #!/usr/bin/env -S uv run --locked --no-sync python
    import subprocess
    import sys
    import tomllib
    from pathlib import Path

    packages = sorted({
        package["name"]
        for package in tomllib.loads(Path("uv.lock").read_text())["package"]
        if "git" in package.get("source", {})
    })
    upgrade_arguments = [
        argument
        for name in packages
        for argument in ("--upgrade-package", name)
    ]
    subprocess.run(["uv", "lock", *upgrade_arguments, *sys.argv[1:]], check=True)
    subprocess.run(["just", "sync"], check=True)
alias uprep := upgrade-repos


# --- Switch python versions -------

# Switches major Python version for the project. Usage: just py-switch 3.13t
py-switch version="3.13":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "🐍 Switching project Python to {{version}}"
    # > Ensure the requested interpreter exists.
    uv python install {{version}}
    # > Persist the project's default interpreter request.
    uv python pin {{version}}
    # > Recreate the project venv with that interpreter.
    uv venv --python {{version}} --seed --clear "$UV_PROJECT_ENVIRONMENT"
    # > Sync dependencies for the recreated environment.
    just sync
    # > Verify via uv, so shell activation state cannot mislead you.
    uv run python -c 'import sys; print(sys.version); print(sys.executable)'




# ---------------------------------------------------------------
# Testing
# ---------------------------------------------------------------

# ---------------------------------------------------------------
# Release workflow
# ---------------------------------------------------------------

[private]
_ci-check-python version environment:
    #!/usr/bin/env bash
    set -euo pipefail
    export UV_PROJECT_ENVIRONMENT="{{environment}}"
    export UV_LINK_MODE=copy
    unset VIRTUAL_ENV
    echo "Python {{version}}: preparing isolated release environment..."
    uv venv --python "{{version}}" "$UV_PROJECT_ENVIRONMENT"
    just sync
    uv lock --check --quiet
    echo "Python {{version}}: environment ready; running checks."
    uv run --python "{{version}}" --locked --no-sync ruff format src tests --check
    uv run --python "{{version}}" --locked --no-sync ruff check src tests
    uv run --python "{{version}}" --locked --no-sync pyright --venvpath "$(dirname "$UV_PROJECT_ENVIRONMENT")"
    uv run --python "{{version}}" --locked --no-sync pytest -m 'not integration and not system'
    uv run --python "{{version}}" --locked --no-sync python -m compileall -q src tests
    echo "Python {{version}}: checks passed."

[private]
_release-artifact-check notes_output build_only="false" notes_input="":
    #!/usr/bin/env bash
    set -euo pipefail
    version="$(uv version --short)"
    identity_args=(--project-version "$version")
    notes_args=()
    if [[ "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
        identity_args+=(--tag "${GITHUB_REF_NAME:?GITHUB_REF_NAME is required for tag builds.}")
    elif [[ "{{build_only}}" == "true" ]]; then
        notes_args+=(--allow-unreleased-entries)
    fi
    notes_output="{{notes_output}}"
    notes_input={{quote(notes_input)}}
    rm -rf dist
    if [[ -z "$notes_output" ]]; then
        : # > An unprepared release rehearsal still checks the package artifacts.
    elif [[ -n "$notes_input" ]]; then
        mkdir -p "$(dirname "$notes_output")"
        if [[ ! -f "$notes_input" ]]; then
            echo "Release notes input must be a regular file: $notes_input" >&2
            exit 1
        fi
        PYTHONPATH=src python -c 'import sys; from ltcook_dev.packaging.release_notes import validate_version; validate_version(sys.argv[1])' "$version"
        if [[ "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
            PYTHONPATH=src python -c 'import sys; from ltcook_dev.packaging.release_notes import validate_tag_version; validate_tag_version(*sys.argv[1:])' "$GITHUB_REF_NAME" "$version"
        fi
        cp -- "$notes_input" "$notes_output"
    else
        python src/ltcook_dev/packaging/release_notes.py "$version" "${identity_args[@]}" "${notes_args[@]}" --output "$notes_output"
    fi
    just build
    shopt -s nullglob
    wheels=(dist/*.whl)
    sdists=(dist/*.tar.gz)
    if [[ "${#wheels[@]}" -ne 1 || "${#sdists[@]}" -ne 1 ]]; then
        echo "Expected exactly one wheel and one sdist in dist/." >&2
        exit 1
    fi
    wheel_distribution="$(printf '%s' "ltcook" | tr '[:upper:]' '[:lower:]' | tr -s '._-' '_')"
    sdist_distribution="$wheel_distribution"
    if [[ "$(basename "${wheels[0]}")" != "${wheel_distribution}-${version}-"*.whl ]]; then
        echo "Expected a normalized project wheel for ${version}." >&2
        exit 1
    fi
    if [[ "$(basename "${sdists[0]}")" != "${sdist_distribution}-${version}.tar.gz" ]]; then
        echo "Expected sdist ${sdist_distribution}-${version}.tar.gz." >&2
        exit 1
    fi
    uv run --with twine --no-project -- twine check "${wheels[0]}" "${sdists[0]}"

build-native:
    PYTHONPATH=src uv run --locked python -m ltcook_distr.build_native

check-native:
    test -x dist/ltcook-setup-linux-x86_64
    (cd dist && sha256sum -c SHA256SUMS)

# -- Stage versioned installer assets without publishing them.
stage-release-assets tag commit destination="release/assets":
    PYTHONPATH=src uv run --locked --no-sync python -m ltcook_dev.packaging.release_stage {{quote(tag)}} {{quote(commit)}} --destination {{quote(destination)}}

# Build standard wheel and sdist once without running the full source matrix.
build-release-inputs notes_file="":
    #!/usr/bin/env bash
    set -euo pipefail
    just _check-uv
    uv lock --check
    just _release-artifact-check dist/release-notes.md true {{quote(notes_file)}}

# Smoke one built wheel in an isolated Python 3.12 tool environment.
release-wheel-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob
    wheels=(dist/*.whl)
    if [[ "${#wheels[@]}" -ne 1 ]]; then echo "Expected exactly one wheel in dist/." >&2; exit 1; fi
    version="$(uv version --short)"
    wheel="$(realpath "${wheels[0]}")"
    artifact_uri="$(python -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().as_uri())' "$wheel")"
    smoke_script="$(realpath src/ltcook_dev/packaging/install_smoke.py)"
    smoke_root="$(mktemp -d)"
    trap 'rm -rf "$smoke_root"' EXIT
    (cd "$smoke_root"; uv run --isolated --python 3.12 --with "ltcook @ $artifact_uri" python "$smoke_script" --expected-version "$version")

release-install-smoke setup="dist/ltcook-setup-linux-x86_64":
    test -f {{quote(setup)}}
    LTCOOK_NATIVE_SETUP="$(realpath {{quote(setup)}})" PYTHONPATH=src uv run --locked --no-sync pytest tests/python/system/test_native_setup.py::test_native_and_editable_uninstall_remove_selected_resources

# Rehearse the release gate. It does not upload anything.
release-check:
    #!/usr/bin/env bash
    set -euo pipefail
    just _check-uv
    check_root="$(mktemp -d)"
    trap 'rm -rf "$check_root"' EXIT
    just sync
    {{quote(BUN)}} run check
    {{quote(BUN)}} run test
    for python_version in 3.12 3.13; do just _ci-check-python "$python_version" "$check_root/python-${python_version}/.venv"; done
    UV_PROJECT_ENVIRONMENT="$check_root/artifacts/.venv" just _release-artifact-check ""
    echo "Local release rehearsal passed. No refs or artifacts were published."


# Prepare a checked version commit and annotated local release tag.
release-prepare level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    just _check-uv
    just _check-clean-worktree "preparing the release"
    requested={{quote(level)}}
    case "$requested" in
        major|minor|patch) next_version="$(uv version --bump "$requested" --dry-run --short)" ;;
        *) next_version="$requested" ;;
    esac
    PYTHONPATH=src python -c 'import sys; from ltcook_dev.packaging.release_notes import validate_next_version; validate_next_version(*sys.argv[1:])' "$(uv version --short)" "$next_version"
    tag="v${next_version}"
    if git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
        echo "Tag ${tag} already exists. Choose another release level." >&2
        exit 1
    fi

    echo "Preparing ${tag} locally."
    release_root="$(mktemp -d)"
    notes_file="$release_root/release-notes.md"
    restore_version_files=false
    cleanup() { exit_code=$?; trap - EXIT; if [[ "$restore_version_files" == true ]]; then cp "$release_root/pyproject.toml" pyproject.toml; cp "$release_root/uv.lock" uv.lock; cp "$release_root/pylock.toml" pylock.toml; fi; rm -rf "$release_root"; exit "$exit_code"; }
    trap cleanup EXIT
    python src/ltcook_dev/packaging/release_notes.py "$next_version" --output "$notes_file"
    cp pyproject.toml uv.lock pylock.toml "$release_root/"
    restore_version_files=true
    uv version "$next_version" --no-sync
    uv export -o pylock.toml --all-extras --all-groups --quiet
    uv lock --check
    # > Isolate the release index so a failed commit cannot leave version files staged.
    GIT_INDEX_FILE="$release_root/index" git read-tree HEAD
    GIT_INDEX_FILE="$release_root/index" git commit --only -m "Bump version to ${next_version}" -- pyproject.toml uv.lock pylock.toml
    restore_version_files=false
    git restore --staged --source=HEAD -- pyproject.toml uv.lock pylock.toml
    if ! git tag -a "$tag" -m "Release ${tag}"; then
        echo "Version commit succeeded, but tag creation failed. Retry with:" >&2
        echo "git tag -a ${tag} -m 'Release ${tag}'" >&2
        exit 1
    fi

    echo
    echo "================================================================="
    echo "✅  RELEASE ${tag} PREPARED LOCALLY"
    echo "================================================================="
    echo
    echo "Nothing has been uploaded."
    echo
    echo "NEXT COMMAND, THIS STARTS THE RELEASE:"
    echo
    echo "  just release-push ${tag}"
    echo
    echo "release-push checks, stages and publishes the Linux assets to GitHub."
    echo "================================================================="

[private]
_wait-release-ci tag commit:
    #!/usr/bin/env bash
    set -euo pipefail
    for attempt in {1..30}; do
        run_id="$(gh run list --repo "$RELEASE_REPOSITORY" --workflow ci.yml --event push --branch {{quote(tag)}} --commit {{quote(commit)}} --json databaseId --jq '.[0].databaseId // empty')"
        if [[ -n "$run_id" ]]; then
            gh run watch --repo "$RELEASE_REPOSITORY" "$run_id" --exit-status
            exit 0
        fi
        sleep 2
    done
    echo "No hosted CI run for this tag and commit. Retry release-push after CI starts." >&2
    exit 1

# Build and verify the tagged Linux bundle locally, then publish it to GitHub.
release-push tag:
    #!/usr/bin/env bash
    set -euo pipefail
    just _check-clean-worktree "pushing the release"
    just _check-gh
    tag={{quote(tag)}}
    version="$(uv version --short)"
    PYTHONPATH=src python -c 'import sys; from ltcook_dev.packaging.release_notes import validate_tag_version; validate_tag_version(*sys.argv[1:])' "$tag" "$version"
    if [[ "$(git branch --show-current)" != main ]]; then
        echo "Release pushes must run from the main branch." >&2
        exit 1
    fi
    ref="refs/tags/$tag"
    commit="$(git rev-parse HEAD)"
    if ! annotated_tag="$(git rev-parse --verify --end-of-options "$ref^{tag}" 2>/dev/null)" ||
       [[ "$(git rev-parse "$ref^{commit}")" != "$commit" ]]; then
        echo "Annotated tag $tag must point to the current main commit." >&2
        exit 1
    fi
    if [[ "$(just _committed-release-policy "$tag" RELEASE_PYPI)" != false ]]; then
        echo "LTCook release commands require RELEASE_PYPI=false." >&2
        exit 1
    fi
    require_ci="$(just _committed-release-policy "$tag" RELEASE_REQUIRE_CI)"

    export PYTHONPATH=src
    publisher=(uv run --locked --no-sync python -m ltcook_dev.packaging.release_assets)
    identity=(--repository "$RELEASE_REPOSITORY" --tag "$tag" --commit "$commit")
    cache=".cache/apprc/releases"
    bundle="$cache/$tag-$commit"
    mkdir -p "$cache"
    exec 9>"$cache/.lock"
    flock 9
    if [[ ! -d "$bundle" ]]; then
        stage="$(mktemp -d "$cache/.staging.XXXXXXXX")"
        trap 'rm -rf "$stage"' EXIT
        python src/ltcook_dev/packaging/release_notes.py "$version" --tag "$tag" \
            --project-version "$version" --output "$stage/release-notes.md"
        just release-check
        just build-native
        just check-native
        just stage-release-assets "$tag" "$commit" "$stage/assets"
        "${publisher[@]}" verify "${identity[@]}" --directory "$stage/assets"
        just release-install-smoke "$stage/assets/ltcook-setup-linux-x86_64"
        (cd "$stage"; sha256sum release-notes.md assets/* > bundle.sha256)
        mv -T --no-clobber "$stage" "$bundle"
    fi
    (cd "$bundle"; sha256sum --strict --check bundle.sha256)
    "${publisher[@]}" verify "${identity[@]}" --directory "$bundle/assets"
    just _check-clean-worktree "publishing the verified release"
    if [[ "$(git branch --show-current)" != main || "$(git rev-parse HEAD)" != "$commit" ||
          "$(git rev-parse --verify --end-of-options "$ref^{tag}")" != "$annotated_tag" ]]; then
        echo "The prepared main commit or annotated tag changed while checking the bundle." >&2
        exit 1
    fi
    git push --atomic origin "$commit:refs/heads/main" "$annotated_tag:$ref"
    if [[ "$require_ci" == true ]]; then
        just _wait-release-ci "$tag" "$commit"
    fi
    "${publisher[@]}" publish "${identity[@]}" --directory "$bundle/assets" \
        --notes "$bundle/release-notes.md"

# Prepare and publish a release using the normal local checks.
release level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    just release-prepare {{quote(level)}}
    tag="v$(uv version --short)"
    if ! just release-push "$tag"; then
        echo "Retry once the reported problem is fixed: just release-push $tag" >&2
        exit 1
    fi

# Run GitHub Actions triggered by push locally using act
gitactions:
    act push \
      --secret-file .env.secret \
      -P ubuntu-latest=catthehacker/ubuntu:act-latest \
      --container-options "-v $HOME/.act-uv-cache:/root/.cache/uv" \
      --action-offline-mode



# ---------------------------------------------------------------
# Convenience
# ---------------------------------------------------------------

# Example: just run -- python -m yourpkg --help
# Runs your package’s CLI or module under the locked environment.
[positional-arguments]
run *CMD:
    #!/usr/bin/env bash
    set -euo pipefail
    just _check-uv
    if [[ "${1-}" == "--" ]]; then
        shift
    fi
    exec uv run --locked -- "$@"

# Print effective dependency tree (won’t modify lock when used with --locked)
tree:
    just _check-uv
    uv tree --locked

# Show uv + Python info for debugging bug reports
diagnose:
    just _check-uv
    uv --version
    uv python list || true
    uv sync --check --all-extras --all-groups


# ---------------------------------------------------------------
# Example recipe written in python (executes venv/python):
# pyyy:
#     #!/usr/bin/env python3
#     import sys
#     print(sys.executable)
#     print('Hello from python!')

[group('Checks')]
format:
    {{quote(BUN)}} run format
    uv run --locked --no-sync ruff format src tests

[group('Checks')]
format-check:
    {{quote(BUN)}} run format:check
    uv run --locked --no-sync ruff format --check src tests

[group('Checks')]
check:
    {{quote(BUN)}} run check
    uv run --locked --no-sync ruff format --check src tests
    uv run --locked --no-sync ruff check src tests
    uv run --locked --no-sync pyright

[group('Checks')]
test:
    {{quote(BUN)}} run test
    uv run --locked --no-sync pytest -m 'not integration and not system'

[group('Checks')]
test-integration:
    uv run --locked --no-sync pytest -m integration
    {{quote(BUN)}} run test:integration

[group('Checks')]
test-system:
    {{quote(BUN)}} run build
    uv run --locked --no-sync pytest -m system

[group('Build')]
build:
    {{quote(BUN)}} run build
    uv sync --locked --all-groups --no-install-project
    PYTHONPATH=src uv run --locked --no-sync python -m ltcook_dev.packaging.package_assets --root . --destination src/ltcook_distr/bundle.zip
    uv build --no-sources --no-build-logs
