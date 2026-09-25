import { Sandbox } from './dev/sandbox';
import { Input } from './engine/input';
import { mul, scaling, translation, type Vec3 } from './engine/math';
import { initPhysics, Physics } from './engine/physics';
import { Pattern, Renderer, type DrawItem } from './engine/renderer';
import { ThirdPersonCamera } from './game/camera';
import { addChamberColliders, drawChamber } from './game/chamber';
import { Hud } from './game/hud';
import { Interaction } from './game/interaction';
import { Player } from './game/player';
import { DartsLevel } from './levels/darts/dartsLevel';
import type { Level, LevelContext } from './levels/level';

const SPAWN: Vec3 = [0, 0, 6];
const params = new URLSearchParams(location.search);
/** `?sandbox` opens the mechanics test room instead of the game. */
const makeLevel = params.has('sandbox')
  ? (ctx: LevelContext) => new Sandbox(ctx)
  : (ctx: LevelContext) => new DartsLevel(ctx);

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

  function freshPhysics() {
    const physics = new Physics();
    addChamberColliders(physics);
    return physics;
  }

  const ctx: LevelContext = { player, camera, hud, input, physics: freshPhysics() };
  player.attach(ctx.physics);

  let playing = false;
  let level: Level = makeLevel(ctx);
  hud.show('THE CHAMBER', 'Click to begin\nWASD move · Mouse look · Shift sprint · Space jump · E use / hold to carry · R restart');
  hud.setLevel('');

  function startLevel() {
    interaction.release();
    ctx.physics.dispose();
    ctx.physics = freshPhysics();
    player.reset(SPAWN);
    player.attach(ctx.physics);
    camera.reset(0);
    level = makeLevel(ctx);
  }

  canvas.addEventListener('click', () => {
    input.lock();
    if (!playing) {
      playing = true;
      startLevel();
    }
  });

  const draws: DrawItem[] = [];
  let last = performance.now();
  let time = 0;

  function tick(dt: number) {
    time += dt;
    if (playing) {
      if (input.wasPressed('KeyR')) startLevel();
      camera.look(dt, input);
      if (player.mode === 'control') player.update(dt, input, camera.yaw, level.obstacles());
      player.syncCollider();
      level.update(dt);
      interaction.update(dt, input, camera, player, ctx.physics);
      ctx.physics.step(dt);
      player.afterPhysics();
      const shot = level.cameraShot();
      if (shot) camera.moveTo(shot.pos, shot.target, dt, shot.sharpness);
      else camera.follow(dt, player);
      hud.crosshair(interaction.state);
    } else {
      // Title screen: slow orbit around the empty chamber.
      const a = time * 0.1;
      camera.moveTo([Math.sin(a) * 26, 24, Math.cos(a) * 26], [0, 2, 0], dt, 2);
      hud.crosshair('hidden');
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
    drawChamber(draws);
    ctx.physics.draw(draws, time);
    player.draw(draws, time);
    level.draw(draws, time);

    renderer.render(draws, view, level.environment(), time);
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
        get physics() { return ctx.physics; },
        player,
        camera,
        interaction,
      },
    });
  }
}

main().catch((e) => showError(String(e instanceof Error ? e.message : e)));
