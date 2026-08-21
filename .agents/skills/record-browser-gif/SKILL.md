---
name: record-browser-gif
description: Record a commit-pinned ClinMesh Web or Desktop workflow as an optimized GIF and publish it to a pull request assets branch. Use for every PR that changes product-user-visible Web/Desktop behavior; do not use browser evidence to claim native Mobile behavior.
---

# Record ClinMesh Browser GIF

Produce a short, truthful demonstration from the exact pull-request commit. `agent-browser` owns interaction and state observation; this skill owns the evidence run, frames, deterministic encoding, artifact inspection, and authorized PR publication.

Every user-visible Web/Desktop PR includes a GIF. The GIF supplements automated regression tests and does not prove resource semantics, Command invariants, or native Mobile behavior.

## Establish evidence

1. Require a clean worktree and record `git rev-parse HEAD`. The demonstrated commit must be the live PR head before and after publication.
2. Start the real ClinMesh entry needed by the scenario from that tree. Use the repository commands for the affected surface, such as `pnpm dev:server`, `pnpm dev:web`, or `pnpm dev:desktop`; use a focused production build when the claim depends on built output.
3. Use fresh ports, an isolated synthetic workspace and epoch, a known Scenario, and a fresh browser or Electron profile. Clear origin storage when a new profile is unavailable and report that exception.
4. Exercise the normal server, adapter, and UI path. A synthetic hospital Scenario is valid product data; mock transports, test-only hooks, and injected DOM state are not valid unless the issue explicitly asks for fixture evidence.
5. Record the commit SHA, app entry, origin, build or development mode, Scenario, and any runtime override next to the GIF.

Never expose real patient information, insurance or payment credentials, platform credentials, unrelated tabs, or notifications. Do not read or print secret values.

## Capture one story

1. Use `agent-browser` to perform the accepted user journey and check console errors.
2. Choose three to six states that prove one outcome: initial, entered, running when useful, settled, and detail or result.
3. Use one viewport and crop. Wait for a semantic condition such as a unique label, enabled control, changed title, resource state, or audit result before each frame. A fixed delay is not proof of state.
4. Require locators to resolve one intended element and use exact text where equality matters. User input echoed elsewhere must not satisfy completion.
5. When the claim involves rejection, recovery, audit, or a Command, include the stable error or status and the downstream observable result.
6. Capture every frame from the same server, workspace, epoch, client profile, and Scenario. If the run fails, discard all frames and restart from fresh state; never splice evidence runs.
7. Write frames under `.playwright-mcp/gif-frames-<label>/` with lexical names such as `00-initial.png` and `01-settled.png`.

## Encode

Require `python3`, `ffmpeg`, and `ffprobe`. Report a missing dependency instead of installing it without authorization.

```sh
export GIF_SKILL_DIR=/absolute/path/to/.agents/skills/record-browser-gif
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/frames \
  /absolute/path/to/demo.gif \
  --durations 1.5,1.5,1.5,3.5 \
  --fps 10 \
  --max-width 1200 \
  --colors 128
```

Use one duration for every frame or one positive duration per frame, holding the final state longest. Reduce width before colors or frame rate when size is high, while keeping clinical text readable.

## Verify the artifact

1. Check the encoder JSON for source and encoded frame counts, dimensions, duration, and byte size.
2. Inspect the encoded GIF itself. Confirm order, readable text, final hold, intended state, and absence of sensitive content. Decode representative frames with `ffmpeg` when the viewer shows only the first frame.
3. Confirm frames and GIF remain under ignored `.playwright-mcp/` paths and do not enter the PR branch.
4. Report the absolute artifact path and its evidence metadata before publication.

## Publish to the PR

The authorized `implement <issue>` workflow permits publication to its draft PR. For a standalone recording request, obtain explicit publication approval first.

Use an append-only orphan assets branch named `<series>-assets`. Create a scratch clone with `mktemp -d`, check out or create the assets branch, copy only verified media, commit with the PR number, and push normally. Never add GIFs to a branch that merges into `main`; never rewrite or delete an assets branch.

Verify the remote object through authenticated GitHub access: path, byte size, checksum, `200` response, and `image/gif` content type. Immediately before editing the PR body, re-read its live head and require it to equal the demonstrated commit. Add the raw blob URL with useful alt text, the commit SHA, entry path, Scenario, and runtime mode. Re-read the head after editing and stop if it moved.

```markdown
![<observable workflow>](https://github.com/<owner>/<repo>/blob/<assets-branch>/<name>.gif?raw=true)
```
