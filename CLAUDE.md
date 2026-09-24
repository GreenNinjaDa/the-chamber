# The Chamber

A level-based 3D survival game in the browser, built directly on WebGPU + WGSL with a small custom engine
(no Three.js / Babylon). Modeled on the approach of dgreenheck/tidewater.

## Game design

- Each level is a different, very novel situation the player must survive. There is no fixed rule, but most
  levels start the same way: over-the-shoulder third-person camera (Fortnite-like), WASD movement, inside a
  nondescript Portal-style test chamber with four white panelled walls and no roof.
- **Level 1 — Darts** (`src/levels/darts/`): a giant rises over the south wall and blocks the sun. Five
  player-sized darts drop into the chamber and his hand hunts the player. The player survives by luring the
  hand onto darts until he has thrown **all five**; the hand gets faster after every grab. If the giant grabs
  the player instead, they are thrown at the dartboard and must steer mid-flight (WASD) into the bullseye to
  survive — anything else is a loss.

## Commands

- `npm run dev` — dev server at http://127.0.0.1:5189 (hot reload)
- `npm run build` — type-check + static build into `dist/`
- Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`

## Layout

- `src/main.ts` — game loop, title screen, level start/restart, dev hook
- `src/engine/` — renderer (primitive meshes, sun shadow map, MSAA, patterns), math (column-major,
  WebGPU clip space z ∈ [0,1]), input
- `src/shaders/*.wgsl` — shaders, imported with `?raw`. Surface patterns (panels, dartboard, blob, skin, sky)
  are ids in `Pattern` (renderer.ts) that must match the constants in scene.wgsl
- `src/game/` — shared pieces every level uses: chamber, player, over-the-shoulder camera, HUD
- `src/levels/level.ts` — the `Level` interface; each level gets its own folder under `src/levels/`

## Adding a level

Implement `Level` (update / draw / environment / obstacles / cameraShot), set `status` to `won` or `lost`
when it ends, and show the result with `hud.show(...)`. Levels can take over the camera by returning a
`CameraShot`, and take over the player by changing `player.mode`.

## Testing without a visible browser

In dev builds `window.__game` exposes `step(seconds)` (fixed 60 Hz simulation steps, then one render),
`level`, `player` and `camera`. The browser pane throttles animation frames while hidden, so drive
play-tests through `__game.step` from the JS tool, and dispatch `KeyboardEvent`s on `window` for input.

## How to work on this project

- Work in small, verifiable steps. After each feature: run the dev server, open it in the browser pane,
  take a screenshot, and check the console for WebGPU validation errors before calling it done.
- Commit after every working step with a clear message so changes are easy to undo.
- Run `npm run build` before committing; it must pass with no TypeScript errors.
- Performance matters: target 60 fps on an RTX 5060 Ti at 1440p. Avoid per-frame allocations in hot loops.
- Keep features toggleable (settings panel or URL flags like `?noClouds`) so they can be isolated when debugging.
- Only use assets with clear licenses (CC0 / MIT / OFL) and record every one in `CREDITS.md`.
