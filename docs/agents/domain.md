# Domain Docs

How engineering skills consume ClinMesh's domain model and architectural decisions.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root for canonical domain vocabulary.
- **`docs/adr/`** for architectural decisions touching the area you are about to modify.

## File structure

Single-context repo:

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-modular-monolith-and-deep-modules.md
│   └── ...
└── src/
```

## Use the glossary's vocabulary

Name domain concepts consistently across issue titles, code interfaces, tests, and UI copy using `GLOSSARY.md`. Avoid synonyms listed under `_Avoid_`. When a genuinely new concept emerges, update `GLOSSARY.md` cleanly rather than inventing ad-hoc names.

## Flag ADR conflicts

If a proposal or existing code contradicts an accepted ADR in `docs/adr/`, surface the conflict explicitly before proceeding rather than silently diverging.
