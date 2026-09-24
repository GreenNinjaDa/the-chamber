# My Game

A real-time 3D browser game built directly on WebGPU + WGSL with a small custom engine (no Three.js / Babylon).
Modeled on the approach of dgreenheck/tidewater.

## Commands

- `npm run dev` — dev server at http://127.0.0.1:5189 (hot reload)
- `npm run build` — type-check + static build into `dist/`
- Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`

## Layout

- `src/main.ts` — device setup, render loop
- `src/math.ts` — matrix helpers (column-major, WebGPU clip space z ∈ [0,1])
- `src/shaders/*.wgsl` — shaders, imported with `?raw`
- As the project grows, split into folders like `src/engine/`, `src/world/`, `src/game/`, `src/post/`, `src/ui/`, `src/audio/`

## How to work on this project

- Work in small, verifiable steps. After each feature: run the dev server, open it in the browser pane,
  take a screenshot, and check the console for WebGPU validation errors before calling it done.
- Commit after every working step with a clear message so changes are easy to undo.
- Run `npm run build` before committing; it must pass with no TypeScript errors.
- Performance matters: target 60 fps on an RTX 5060 Ti at 1440p. Avoid per-frame allocations in hot loops.
- Keep features toggleable (settings panel or URL flags like `?noClouds`) so they can be isolated when debugging.
- Only use assets with clear licenses (CC0 / MIT / OFL) and record every one in `CREDITS.md`.
