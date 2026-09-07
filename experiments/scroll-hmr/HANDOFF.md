# Handoff: Storybook scroll-loss-on-HMR (#22057) — investigation, experiments, and implemented fix

Written 2026-09-07 as a self-contained briefing for an agent continuing this work on a new
git origin. Everything below was verified against real code and/or measured in instrumented
browser trials; file:line references are from a branch based on storybookjs/storybook `next`
(HEAD around merge commit `7e7251e00`, June 2026) and may drift slightly.

## 1. Context

- **Issue**: storybookjs/storybook#22057 (also #26060) — editing a story file while scrolled
  down a tall story in `viewMode=story` jumps the preview back to the top after HMR.
  Users report it "works very inconsistently".
- **Prior art**: PR #35021 fixed the same symptom for the **docs** path by passing
  `scrollReset: false` to `view.prepareForDocs()` on HMR re-renders.
- **PR #35205** (author: Steve Dodier-Lazaro, sidnioulz — the user) mirrored that for the
  story path: `renderSelection` passes `scrollReset: storyIdChanged || viewModeChanged` to
  `view.prepareForStory()`, guarding the explicit `document.documentElement.scrollTop = 0`
  in `WebView.prepareForStory`. **It did not fix the bug.** This work explains why, proves
  it experimentally, and implements the complete fix.

## 2. Root-cause model (verified in code, then confirmed in vivo)

The key insight: **on the failing path, no code writes `scrollTop` at all.** The *browser*
clamps the scroll offset whenever a layout pass runs while the document is collapsed
(shorter than the scroll position). Guarding the explicit reset therefore changes nothing
until the collapses themselves are fixed — at which point the guard becomes load-bearing.

Two independent collapse mechanisms fire on every same-story HMR re-render:

### KILL-1 — teardown-before-remount (two-layered)

`PreviewWithSelection.renderSelection()` (in
`code/core/src/preview-api/modules/preview-web/PreviewWithSelection.tsx`) awaits
`teardownRender(lastRender, { viewModeChanged })` before starting the new render.

- Layer 1: `StoryRender.teardown()`
  (`code/core/src/preview-api/modules/preview-web/render/StoryRender.ts`) ignored
  `viewModeChanged` and always ran the renderer teardown — for React,
  `act(() => unmountElement(canvasElement))` → `root.unmount()` empties
  `#storybook-root`. Between the unmount and the new commit sit real async boundaries
  (`cleanupStory`, up to 3× `setTimeout(0)`, `applyLoaders`, `applyBeforeEach`, dynamic
  import of react-dom-shim, the renderer's act queue). Measured gap on a trivial story:
  13–25 ms — a layout pass inside it clamps scroll to 0.
- Layer 2: even if teardown is skipped, the react renderer
  (`code/renderers/react/src/renderToCanvas.tsx`) did its own
  `if (forceRemount) unmountElement(canvasElement)` — and every HMR render goes through
  `renderToElement` → `render({ initial: true, forceRemount: true })`. Guarding only
  layer 1 just moves the collapse ~10 ms later (measured: still 0/5 kept).

Contrast with docs, which never had this problem: `CsfDocsRender.teardownRender` no-ops
unless `viewModeChanged` (`code/core/src/preview-api/modules/preview-web/render/CsfDocsRender.ts`
~:154-159), and the react-dom-shim caches roots per element
(`code/lib/react-dom-shim/src/react-18.tsx`: `nodes` map — `renderElement` reuses an
existing root, so docs re-renders reconcile in place in one commit).

### KILL-2 — the 100 ms "preparing" spinner

`renderSelection` unconditionally called `view.showPreparingStory({ immediate: viewModeChanged })`
at entry. `WebView.showPreparingStory`
(`code/core/src/preview-api/modules/preview-web/WebView.ts`, `PREPARING_DELAY = 100`) arms a
100 ms timer → `showMode(PREPARING_STORY)` → adds `sb-show-preparing-story` **and removes
`sb-show-main`** (showMode removes all other mode classes). The preview CSS
(`code/core/assets/server/base-preview-head.html` ~:5-7):

```css
.sb-show-preparing-story:not(.sb-show-main) > :not(.sb-preparing-story) { display: none; }
```

hides every body child → document collapses → clamp. Crucially, **the only thing that
defuses the timer on the story path is `ErrorBoundary.componentDidMount → showMain()`**
(`renderToCanvas.tsx` ErrorBoundary) — i.e. only a full remount clears it.
`showStoryDuringRender()` re-adds `sb-show-main` but never clears the timeout. So any HMR
cycle slower than 100 ms lost scroll through this alone — and under root reuse (no fresh
`componentDidMount`) the timer would *always* detonate (measured: config B2 below, 0/10).

### Secondary mechanisms (confirmed in code; mostly untested in vivo)

- **KILL-3 / hard reloads**: `StoryRender.teardown`'s `window.location.reload()` fallback
  when the old render is still pending after 3 ticks (saves mid-play / slow loaders);
  builder-vite's vite-mock plugin unconditionally full-reloads the iframe on any
  `.storybook/preview.*` edit (`code/builders/builder-vite/src/plugins/vite-mock/`); HMR
  dead-ends at the iframe entry cause Vite full reloads.
- **H3 / edit-path bifurcation**: story files are stripped of HMR boundaries
  (`strip-story-hmr-boundaries.ts`), so story edits *always* remount. Component edits
  fast-refresh in place only if the user's own vite config has `@vitejs/plugin-react`
  (the react-vite framework does not add it). Explains contradictory user reports.
- **H4 / racing passes**: each save triggers 2–3 `renderSelection` passes (importFn HMR,
  duplicate HMR the codegen plugin TODO admits, index-invalidation refetch). Observed in
  every trace; trailing passes usually hit the benign `STORY_UNCHANGED` shortcut, but one
  captured trace shows a full second teardown/remount cycle ~350 ms after the first.
- **H6 / docs residuals**: `key={Math.random()}` in DocsRenderer forces full subtree swaps;
  `<Story>` blocks commit empty and fill in async (height dip); a stale URL `#hash`
  re-anchors ~200 ms after re-renders.
- **H7 / autoplay**: play functions re-run on every HMR (`forceRemount` + autoplay);
  `userEvent` focus/click scrolls its target into view; addon-a11y can `scrollIntoView` a
  selected violation after every `STORY_HOT_UPDATED`.

## 3. The experiments (the proof)

Harness (committed under `experiments/scroll-hmr/` on the old branch; reproduce-able from
the README there): a `react-vite/default-ts` sandbox linked to the local build; a zero-patch
probe in `.storybook/preview-head.html` recording scroll/height/DOM mutations/body-class
flips/channel events with ms timestamps; four **inert levers** compiled into core+renderer,
toggled per page load via a `?__exp=` URL param; a Playwright driver that scrolls to
y=1500, rewrites the story file on disk (real Vite HMR), and samples scroll. Two stories:
fast (tall static) and slow (300 ms loader). 70 trials.

| Config | guard | noSpinner | keepDom | keepRoot | fast | slow | loss fingerprint |
|---|---|---|---|---|---|---|---|
| baseline (PR #35205 as-is) | ✔ | – | – | – | 0/5 | 0/5 | unmount collapse |
| guard reverted | – | – | – | – | 0/5 | 0/5 | unmount collapse — **identical to baseline** |
| A: spinner off | ✔ | ✔ | – | – | 0/5 | 0/5 | unmount collapse |
| B1: teardown guard only | ✔ | – | ✔ | – | 0/5 | 0/5 | renderToCanvas 2nd unmount / spinner |
| B2: teardown + root reuse | ✔ | – | ✔ | ✔ | 0/5 | 0/5 | spinner (timer never defused) |
| **all three** | ✔ | ✔ | ✔ | ✔ | **5/5** | **5/5** | — |
| all fixes, guard reverted | – | ✔ | ✔ | ✔ | 0/5 | 0/5 | explicit `scrollTop=0` at **full** doc height |

Three distinct trace fingerprints separate the killers: (1) clamp with height collapsed at
`#storybook-root` emptying; (2) clamp with height collapsed at body-class flip to
`sb-show-preparing-story` at exactly +100 ms; (3) clamp at *full* height at the `loading`
phase = the explicit reset in `prepareForStory`.

Conclusions: the PR guard is **necessary but not sufficient**; KILL-1 and KILL-2 are each
individually fatal; the teardown fix must cover **both** unmount layers; root reuse works
(the one-commit swap visibly preserves scroll) but requires explicit spinner defusal.

Caveat: the probe's scroll reads force layout inside the gap, making the fast-path timing
lottery near-deterministic in-harness. Identical across configs, so comparisons hold.

Full illustrated report (private artifact, owned by the user):
https://claude.ai/code/artifact/4c83f8cc-6095-4c0b-9925-9d2e47d0c906

## 4. The implemented fix (validated)

Commit "UI: Keep story DOM and React root mounted across same-story HMR re-renders"
(`7bb4714de` on the old fork). Three coordinated parts on top of the PR's existing
`scrollReset` guard (which stays):

1. **`PreviewWithSelection.tsx`**
   - Spinner gating: `showPreparingStory` / `showPreparingDocs` only when
     `storyIdChanged || viewModeChanged`.
   - Teardown: passes `keepRenderedDom: !storyIdChanged && !viewModeChanged` to
     `teardownRender`, which threads it into `render.teardown(...)`.
2. **`render/StoryRender.ts`** — `teardown({ keepRenderedDom = false })` skips
   `this.teardownRender()` when set (abort/`cleanupStory`/reload-fallback unchanged;
   `remount()` and error paths keep full teardown). `render/Render.ts` interface extended
   with the optional `keepRenderedDom`.
3. **`renderers/react/src/renderToCanvas.tsx`** — for regular stories, `forceRemount` no
   longer unmounts the root. Instead a per-canvas `WeakMap` counter bumps on each
   forceRemount and feeds the `ErrorBoundary` key
   (`` key={`${storyContext.id}-${count}`} ``), so React recreates component instances
   *within one commit* (preserves react-storybook#81 "fresh instances" semantics) and the
   document never observably empties. This also re-fires `componentDidMount → showMain()`
   per remount, defusing any armed preparing timer. **Portable stories keep the old
   unmount** (they render without the keyed boundary). Args/globals rerenders don't bump
   the counter → key stable → component state preserved, as before.

Tests (in `PreviewWeb.test.ts`): two existing tests intentionally **flipped** to
`not.toHaveBeenCalled()` on the teardown mock — same-story HMR ("when the current story
changes") and `onGetProjectAnnotationsChanged` (also a same-story re-render). Two new
tests: spinner not armed on HMR; DOM kept on HMR. Navigation/viewMode/story-missing
teardown assertions unchanged and passing.

### Validation

- Same harness, **no** lever flags: **10/10 kept** (fast 5/5, slow 5/5) where the pre-fix
  build measured 0/10.
- Regression checks via channel events in the sandbox: story→story `setCurrentStory` still
  resets scroll to 0 and arms the spinner; `forceRemount` event still fully
  unmounts/remounts.
- Unit tests: 191 (PreviewWeb+StoryRender) + 617 (preview-api dir) + 632 (react renderer)
  pass; `yarn nx run-many -t check -p core react` clean.

### Known judgment calls / nuances for review

- A reused React root keeps its original `parameters.react.rootOptions` until the next
  navigation/remount recreates it (only observable when hot-editing rootOptions).
- `onGetProjectAnnotationsChanged` (preview.ts edits in non-Vite builders) now also keeps
  DOM — intended, it's a same-story re-render. On Vite this path hard-reloads anyway
  (vite-mock).
- Non-react renderers get the teardown + spinner halves; their own `renderToCanvas`
  unmount on forceRemount still collapses (smaller window — strictly better than before,
  not fully fixed). See follow-ups.
- If a story render *errored* and is then HMR-re-rendered: fresh key → fresh boundary →
  recovery works (verified by reasoning; the keyed remount resets `hasError`).

## 5. State of the old branch (fork sidnioulz/storybook, branch `claude/storybook-scroll-hmr-investigation-40gdz1`)

Commits, oldest→newest:

1. `5330485e0` — the user's original PR #35205 commit (scrollReset guard). **Keep.**
2. `83c6527ab` — experimental levers + apparatus (levers later removed again). Historical.
3. `54c94c8c0`, `4a0aca218` — experiment tooling iterations. Historical.
4. `04b4cf454` — experiment results, README, representative traces. Optional to keep.
5. `7bb4714de` — **the fix** (levers removed, real change + tests). **Keep.**

For a clean upstream PR against storybookjs `next`: cherry-pick or re-apply 1 + 5.
Drop from the upstream diff: `experiments/scroll-hmr/` (or keep — maintainer's call),
`scripts/utils/yarn.ts` `SB_LOCAL_YARN_RELEASE` support (a sandbox-env workaround for a
network-restricted environment, not related to the fix — split into its own PR if wanted),
and this handoff file. The PR body should lead with the experiment table — it preempts
"why not just the guard?" review questions. Base branch must be `next`.

## 6. Follow-ups (none blocking the PR)

- **Other renderers** (vue3, svelte, web-components, html…): mirror the react approach —
  on forceRemount, replace content in place instead of unmount-then-mount where the
  framework allows a one-commit swap. Until then they keep a shrunken B1-style gap.
- **Docs residuals (H6)**: `key={Math.random()}` in `DocsRenderer.tsx`; async `<Story>`
  blocks height dip; stale `#hash` re-anchoring in `DocsContainer.tsx`.
- **H4 racing passes**: dedupe the 2–3 `renderSelection` calls per save (codegen plugin has
  a TODO about the double HMR); the occasional second full cycle can still cause a flash.
- **H7**: consider skipping autoplay on HMR re-renders, or `preventScroll` focus handling;
  addon-a11y's post-HMR `scrollIntoView`.
- **vite-mock preview reload**: `.storybook/preview.*` edits always full-reload on Vite —
  scroll loss by design; a sessionStorage capture/restore would cover it.
- **Belt-and-braces**: snapshot `scrollTop` at `renderSelection` entry and restore after
  commit — covers H4/H6 residuals; deliberately *not* included in the fix (not needed for
  10/10 and it papers over mechanisms).
- **Untested cells**: webpack5 builder, CSF4/csf-factories HMR topology, docs-path trials,
  play-function stories, mid-play saves.

## 7. Environment/repro notes (for a network-restricted remote env)

- Sandbox: `yarn task sandbox --template react-vite/default-ts --start-from auto`. If
  `repo.yarnpkg.com` is blocked, corepack cannot fetch yarn — do NOT `corepack enable`
  (it replaces the global yarn shim and then every yarn call tries the blocked download;
  recovery: `corepack disable && npm i -g yarn@1.22.22`). Instead reuse the repo's checked-in
  release: `SB_LOCAL_YARN_RELEASE=$PWD/.yarn/releases/yarn-<ver>.cjs yarn task sandbox …`
  (support added in `scripts/utils/yarn.ts` on the old branch).
- The generated sandbox may pull a newer `@storybook/addon-mcp` than local core supports
  (`storybook/internal/skills` export missing) — remove it from the sandbox's
  `.storybook/main.ts` addons.
- Playwright: use the sandbox's own `playwright` install, launched with
  `executablePath: '/opt/pw-browsers/chromium'` (pre-installed browser; version-pinned
  downloads are blocked).
- Never pipe a long-running dev server through `head`/`tail` in a background shell — when
  the pipe closes, SIGPIPE kills the server mid-experiment. Redirect to a file.
- Driver usage: copy `probe-preview-head.html` → sandbox `.storybook/preview-head.html`,
  `driver.mjs` → sandbox root; `TRIALS=5 node driver.mjs` (env `ONLY=config[:story],…`
  filters). `analyze.py` classifies loss fingerprints from the traces.
