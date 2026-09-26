import { Sandbox } from './dev/sandbox';
import { Input } from './engine/input';
import { mul, multiply, scaling, translation, type Mat4, type Vec3 } from './engine/math';
import { initPhysics, Physics } from './engine/physics';
import { Pattern, Renderer, type DrawItem } from './engine/renderer';
import { ThirdPersonCamera } from './game/camera';
import { addChamberColliders, drawChamber } from './game/chamber';
import { Hud, type ScreenLabel, type ScreenMarker } from './game/hud';
import { Interaction } from './game/interaction';
import { PauseMenu } from './game/pauseMenu';
import { Player } from './game/player';
import { settings } from './game/settings';
import { DartsLevel } from './levels/darts/dartsLevel';
import { CakeLevel } from './levels/cake/cakeLevel';
import { ClawLevel } from './levels/claw/clawLevel';
import { GrenadeLevel } from './levels/grenade/grenadeLevel';
import { LavaLevel } from './levels/lava/lavaLevel';
import { TempleLevel } from './levels/temple/templeLevel';
import type { Level, LevelContext, TrackedTarget, WorldLabel } from './levels/level';
import { LobbyLevel } from './levels/lobby/lobbyLevel';

const SPAWN: Vec3 = [0, 0, 6];
/** Seconds on the title screen before the game starts by itself. */
const TITLE_AUTOSTART = 10;
/** The game's levels, in order. */
const LEVELS: ((ctx: LevelContext) => Level)[] = [
  (ctx) => new DartsLevel(ctx),
  (ctx) => new GrenadeLevel(ctx),
  // Meant to be a secret level reached by an easter egg; level 3 for now.
  (ctx) => new CakeLevel(ctx),
  (ctx) => new LavaLevel(ctx),
  (ctx) => new TempleLevel(ctx),
  (ctx) => new ClawLevel(ctx),
];
const params = new URLSearchParams(location.search);
/** `?sandbox` opens the mechanics test room; `?level=N` skips the lobby and starts at level N. */
const sandbox = params.has('sandbox');
let levelIndex = Math.min(LEVELS.length - 1, Math.max(0, (Number(params.get('level')) || 1) - 1));
/** The lobby is the main menu: a chamber you walk around in, with a START portal. */
let inLobby = !params.has('level');
const makeLevel = (ctx: LevelContext) =>
  sandbox ? new Sandbox(ctx) : inLobby ? new LobbyLevel(ctx, LEVELS.length) : LEVELS[levelIndex](ctx);

/** Where each tracked target is on screen: a ring if visible, otherwise an edge arrow toward it. */
function screenMarkers(targets: TrackedTarget[], view: Mat4, proj: Mat4, fov: number): ScreenMarker[] {
  const w = window.innerWidth, h = window.innerHeight;
  const margin = 44;
  const viewProj = multiply(proj, view);
  return targets.map(({ pos, radius, color }) => {
    const cx = viewProj[0] * pos[0] + viewProj[4] * pos[1] + viewProj[8] * pos[2] + viewProj[12];
    const cy = viewProj[1] * pos[0] + viewProj[5] * pos[1] + viewProj[9] * pos[2] + viewProj[13];
    const cw = viewProj[3] * pos[0] + viewProj[7] * pos[1] + viewProj[11] * pos[2] + viewProj[15];
    const nx = cx / cw, ny = cy / cw;
    if (cw > 0.05 && Math.abs(nx) <= 1 && Math.abs(ny) <= 1) {
      const pxPerUnit = h / (2 * Math.tan(fov / 2) * cw);
      return { onScreen: true, x: (nx * 0.5 + 0.5) * w, y: (0.5 - ny * 0.5) * h, size: Math.max(26, radius * 2 * pxPerUnit + 16), angle: 0, color };
    }
    // Off screen: point along the target's direction in camera space (right / up), which also
    // does the sensible thing for targets behind the camera (e.g. behind and below = down).
    const vx = view[0] * pos[0] + view[4] * pos[1] + view[8] * pos[2] + view[12];
    const vy = view[1] * pos[0] + view[5] * pos[1] + view[9] * pos[2] + view[13];
    let dx = vx, dy = -vy;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = 1;
    const t = Math.min((w / 2 - margin) / Math.max(Math.abs(dx), 1e-6), (h / 2 - margin) / Math.max(Math.abs(dy), 1e-6));
    return { onScreen: false, x: w / 2 + dx * t, y: h / 2 + dy * t, size: 0, angle: Math.atan2(dy, dx), color };
  });
}

/** Projects floating world text to the screen, sized by distance; skips anything off screen. */
function screenLabels(labels: WorldLabel[], view: Mat4, proj: Mat4, fov: number): ScreenLabel[] {
  const w = window.innerWidth, h = window.innerHeight;
  const viewProj = multiply(proj, view);
  const out: ScreenLabel[] = [];
  for (const { pos, text, size, color } of labels) {
    const cx = viewProj[0] * pos[0] + viewProj[4] * pos[1] + viewProj[8] * pos[2] + viewProj[12];
    const cy = viewProj[1] * pos[0] + viewProj[5] * pos[1] + viewProj[9] * pos[2] + viewProj[13];
    const cw = viewProj[3] * pos[0] + viewProj[7] * pos[1] + viewProj[11] * pos[2] + viewProj[15];
    if (cw < 0.3) continue;
    const nx = cx / cw, ny = cy / cw;
    if (Math.abs(nx) > 1.3 || Math.abs(ny) > 1.3) continue;
    const px = (size * h) / (2 * Math.tan(fov / 2) * cw);
    if (px < 5) continue;
    out.push({ x: (nx * 0.5 + 0.5) * w, y: (0.5 - ny * 0.5) * h, px, text, color });
  }
  return out;
}

function showError(message: string) {
  const el = document.getElementById('error')!;
  el.textContent = message;
  el.style.display = 'grid';
}

async function main() {
  const canvas = document.getElementById('gfx') as HTMLCanvasElement;
  const [renderer] = await Promise.all([Renderer.create(canvas), initPhysics()]);
  renderer.device.lost.then((info) => showError(`GPU device lost: ${info.message}`));

  const hud = new Hud();
  const input = new Input(canvas);
  const player = new Player();
  const camera = new ThirdPersonCamera();
  const interaction = new Interaction();

  // Chamber colliders are added after the level is created, since levels can tweak the chamber.
  const freshPhysics = () => new Physics();

  const ctx: LevelContext = { player, camera, hud, input, physics: freshPhysics() };
  player.attach(ctx.physics);

  let playing = false;
  let level: Level = makeLevel(ctx);
  addChamberColliders(ctx.physics, level.chamber);
  hud.show('THE CHAMBER', 'Click to begin\nWASD move · Mouse look · Shift sprint · Space jump · E use · Hold click carry · Right-click throw · R restart · Esc pause');
  hud.setLevel('');

  function startLevel() {
    interaction.release();
    ctx.physics.dispose();
    ctx.physics = freshPhysics();
    player.reset(SPAWN);
    player.attach(ctx.physics);
    camera.reset(0);
    hud.hide();
    level = makeLevel(ctx);
    addChamberColliders(ctx.physics, level.chamber);
    nextOffered = false;
  }

  // Pausing: Esc (or losing the mouse some other way) opens the menu. Browsers swallow the
  // Esc that releases the mouse, or deliver it as well, so ignore an Esc right after a pause.
  let pausedAt = 0;
  const pauseMenu = new PauseMenu({
    resume,
    restart: () => {
      startLevel();
      resume();
    },
    lobby: () => {
      inLobby = true;
      startLevel();
      resume();
    },
  });
  function pause() {
    if (!playing || pauseMenu.isOpen) return;
    pausedAt = performance.now();
    pauseMenu.open(inLobby);
    hud.crosshair('hidden');
    interaction.release();
  }
  function resume() {
    pauseMenu.close();
    input.lock();
  }
  // Losing the mouse pauses, except in the lobby when it's because you tabbed away (the lobby
  // is harmless, and its AFK pranks are for exactly those people). Esc still pauses there: that
  // releases the mouse too, so wait a moment and see whether the window lost focus.
  input.onUnlock = () => {
    if (!inLobby) return pause();
    setTimeout(() => {
      if (inLobby && document.hasFocus() && !document.hidden) pause();
    }, 150);
  };

  function begin() {
    if (playing) return;
    playing = true;
    startLevel();
  }
  // Clicking starts the game (and grabs the mouse); so does sitting on the title screen too long.
  // Without a click there's no mouse lock yet, so the first click in the chamber takes it.
  canvas.addEventListener('click', () => {
    input.lock();
    begin();
  });

  const draws: DrawItem[] = [];
  let last = performance.now();
  let time = 0;

  let nextOffered = false;

  function tick(dt: number) {
    time += dt;
    if (playing && input.wasPressed('Escape')) {
      if (!pauseMenu.isOpen) pause();
      else if (performance.now() - pausedAt > 300) resume();
    }
    if (playing && pauseMenu.isOpen) {
      // Frozen: keep drawing, advance nothing.
    } else if (playing) {
      if (input.wasPressed('KeyR')) startLevel();
      // After a win, N moves on to the next chamber.
      const hasNext = !sandbox && levelIndex < LEVELS.length - 1;
      if (level.status === 'won' && hasNext) {
        if (!nextOffered) {
          nextOffered = true;
          hud.hint('N — next chamber');
        }
        if (input.wasPressed('KeyN')) {
          levelIndex++;
          startLevel();
        }
      }
      // Through an exit portal: from the lobby to the chosen level, then straight on to the next
      // chamber (after the last, back to the lobby).
      if (level.status === 'exited' && !sandbox) {
        let finished = false;
        if (inLobby) {
          inLobby = false;
          levelIndex = Math.min(LEVELS.length - 1, Math.max(0, settings.startLevel - 1));
        } else if (levelIndex < LEVELS.length - 1) {
          levelIndex++;
        } else {
          inLobby = finished = true;
        }
        startLevel();
        if (finished) hud.show("THAT'S ALL, FOLKS", 'Every chamber so far. The rest are still being built. Probably.', 4);
      }
      camera.look(dt, input);
      const frozen = level.freezeWorld?.() ?? false;
      if (!frozen) {
        if (player.mode === 'control' && !player.inPortal) player.update(dt, input, camera.yaw, level.obstacles(), camera.pitch);
        player.syncCollider();
      }
      level.update(dt);
      if (!frozen) {
        player.tickPortal(dt);
        interaction.update(dt, input, camera, player, ctx.physics);
        ctx.physics.step(dt);
        player.afterPhysics();
      }
      const shot = level.cameraShot();
      if (shot) camera.moveTo(shot.pos, shot.target, dt, shot.sharpness);
      else camera.follow(dt, player);
      hud.crosshair(interaction.state);
    } else {
      // Title screen: slow orbit around the empty chamber.
      const a = time * 0.1;
      camera.moveTo([Math.sin(a) * 26, 24, Math.cos(a) * 26], [0, 2, 0], dt, 2);
      hud.crosshair('hidden');
      if (time >= TITLE_AUTOSTART) begin();
    }
    hud.update(dt);
    input.endFrame();
  }

  function draw(dt: number) {
    const view = camera.view(renderer.aspect, dt);
    draws.length = 0;
    draws.push({
      mesh: 'sphere',
      model: mul(translation(view.pos), scaling([-700, 700, 700])),
      color: [0, 0, 0],
      pattern: Pattern.sky,
      shadow: false,
    });
    drawChamber(draws, level.chamber);
    ctx.physics.draw(draws, time);
    player.draw(draws, time);
    level.draw(draws, time);

    renderer.render(draws, view, level.environment(), time);
    hud.markers(playing ? screenMarkers(level.trackedTargets?.() ?? [], view.view, view.proj, camera.fov) : []);
    hud.labels(playing ? screenLabels(level.labels?.() ?? [], view.view, view.proj, camera.fov) : []);
  }

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt);
    draw(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Dev-only hook for automated play-testing: advance the simulation in fixed steps.
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __game: {
        step(seconds: number) {
          for (let t = 0; t < seconds; t += 1 / 60) tick(1 / 60);
          draw(1 / 60);
        },
        get level() { return level; },
        get paused() { return pauseMenu.isOpen; },
        pause,
        resume,
        get physics() { return ctx.physics; },
        player,
        camera,
        interaction,
      },
    });
  }
}

main().catch((e) => showError(String(e instanceof Error ? e.message : e)));
