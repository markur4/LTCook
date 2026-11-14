# Guidance resource provenance

This file records the source and adaptation of imported guidance. Source paths are repository-relative and omit the local host's user directories.

## Authoritative planning reference

- Source: user-provided `IDEAS - MODES Design, Plan, Goal, Refactor.md` note.
- Revision: content SHA-256 `e212919aff93a2c64434fc85c0db18cce09daf712be83ac82dfdf0f28e188aa7`, read on 2026-11-14; the note is not backed by a Git revision.
- Destination: `skills/ltcook-planning/references/modes.md`.
- Adaptation: none. The complete 685-line source is copied byte for byte. `skills/ltcook-planning/SKILL.md` is a short native-Pi wrapper that points to the complete source and the runtime workflow.

## Clear Writing rule

- Source repository: `github.com/markur4/dotfiles`, revision `8c135638df4dcaf1ed6e9f4d3cf4ce6b4182f81e`.
- Source file: `dot_omp/private_agent/rules/clear-writing.md`.
- Revision content SHA-256: `5fbd43b8d4a5b310cf563ee96fc0d535b538455714b28c2187b1d5ecb8946d69`.
- Destination: `rules/clear-writing.md`.
- Adaptation and license: none recorded in the source file; the rule is copied byte for byte without added metadata.

## Shared Lookup and Explore skills

- Source repository: LTCook at base revision `83199b41a3e2004112aaf15545198bf6c865322b`.
- Source files: `teams/default/resources/skills/lookup.md` (SHA-256 `0ed83178acf51bc91c5983116756fce74408a3e7969361f9f30bb16ca5494fb0`) and `teams/default/resources/skills/explore.md` (SHA-256 `b20cd8d793b6cd0a5537f2f28782ac903ac71cbc70b92325bf90bceb1fbc419c`).
- Adaptation: the shared method paragraphs are unchanged. Their original Team-specific handoff paragraphs are retained verbatim in `teams/default/resources/rules/research-handoffs.md` rather than in Core skills.

## Optional skills from OMP guidance

- Source repository: `github.com/markur4/dotfiles`, revision `8c135638df4dcaf1ed6e9f4d3cf4ce6b4182f81e`.
- TypeScript source file: `dot_omp/private_agent/skills/typescript-best-practices/SKILL.md`; content SHA-256 `ee33b90260ce17caaa5b1f02221ee0576d6627a730346e6a8fc3a371df1dd954`.
- React/Vite source file: `dot_omp/private_agent/skills/vercel-react-best-practices/SKILL.md`; content SHA-256 `7e71835dcff6dc3a407385f447149635f4b8507ab4895e1f77b4917544a81ff3`.
- Reader-load source file: `dot_omp/private_agent/skills/principle-minimize-reader-load/SKILL.md`; content SHA-256 `c6d5cee6c8d235c33e8ba74a1de0de3b07c42fe9108b0c78fd322055c895d5d8`.
- Destinations: `skills/ltcook-typescript/`, `skills/ltcook-react-vite/`, and `skills/ltcook-reader-load/`.
- Adaptation: source directories and frontmatter names receive the agreed `ltcook-` names. Skill bodies, descriptions, notices, license files, references, and invocation settings are retained. Reader-load remains explicit-only (`disable-model-invocation: true`).
- Licensing: the TypeScript and reader-load sources include MIT license files; the React/Vite source declares MIT in its unchanged frontmatter. No additional source notice was present in the imported directories.
