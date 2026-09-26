import type { DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { junk, spawnJunk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { Button, Lever } from '../../entities/props';
import { saveSettings, settings } from '../../game/settings';
import { AfkPranks } from './afk';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type WorldLabel } from '../level';

/*
 * The lobby: the "main menu" is a chamber you walk around in. Buttons pick the level, more
 * buttons and a lever change settings, and the START portal in the east wall goes to the game.
 */

const SELECTED = [0.15, 0.8, 0.2];
const UNSELECTED = [0.45, 0.46, 0.5];
const MOUSE_MIN = 0.2;
const MOUSE_MAX = 4;
const WALL = CHAMBER_HALF - 0.08;
const LEVELS_PER_ROW = 8;

export class LobbyLevel implements Level {
  readonly number = 0;
  readonly title = 'Lobby';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private levelButtons: Button[] = [];
  private fixedLabels: WorldLabel[] = [];
  private allLabels: WorldLabel[] = [];
  private startLabel: WorldLabel;
  private mouseLabel: WorldLabel;
  private invertLabel: WorldLabel;
  private soundLabel: WorldLabel;
  /** Pranks for players who wander off and leave their character standing here. */
  readonly afk: AfkPranks;
  private deadFor = 0;

  constructor(private ctx: LevelContext, levelCount: number) {
    const { physics, hud } = ctx;
    hud.setLevel('The Chamber · Lobby');
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);
    this.exit.openAlready();
    this.afk = new AfkPranks(ctx);
    settings.startLevel = Math.min(levelCount, Math.max(1, settings.startLevel));

    // Level select: rows of buttons along the north side (up to LEVELS_PER_ROW in a row).
    const rows = Math.ceil(levelCount / LEVELS_PER_ROW);
    const firstRowZ = rows > 1 ? -9.6 : -8;
    for (let i = 0; i < levelCount; i++) {
      const row = Math.floor(i / LEVELS_PER_ROW), inRow = Math.min(LEVELS_PER_ROW, levelCount - row * LEVELS_PER_ROW);
      const x = ((i % LEVELS_PER_ROW) - (inRow - 1) / 2) * 2.6;
      const z = firstRowZ + row * 3;
      const button = new Button(physics, [x, 0, z], UNSELECTED, () => this.pickLevel(i + 1));
      this.levelButtons.push(button);
      this.fixedLabels.push({ pos: [x, 1.75, z], text: `LEVEL ${i + 1}`, size: 0.3 });
    }
    this.fixedLabels.push({ pos: [0, rows > 1 ? 3.1 : 2.55, firstRowZ], text: 'PICK YOUR POISON', size: 0.42, color: '#ffd166' });
    this.pickLevel(settings.startLevel);

    // Mouse speed: slower / faster buttons, and a lever to invert looking up and down.
    new Button(physics, [-8, 0, -1.4], [0.2, 0.45, 0.9], () => this.changeMouse(1 / 1.2));
    new Button(physics, [-8, 0, 1.4], [0.95, 0.5, 0.1], () => this.changeMouse(1.2));
    this.fixedLabels.push({ pos: [-8, 1.8, -1.4], text: '–', size: 0.5 }, { pos: [-8, 1.8, 1.4], text: '+', size: 0.5 });
    this.mouseLabel = { pos: [-8, 2.6, 0], text: '', size: 0.3, color: '#ffd166' };
    const lever = new Lever(physics, [-8, 0, 5], Math.PI / 2, (on) => {
      settings.invertY = on;
      saveSettings();
      this.refreshLabels();
    });
    lever.on = settings.invertY;
    this.invertLabel = { pos: [-8, 2.3, 5], text: '', size: 0.26, color: '#ffd166' };
    const soundLever = new Lever(physics, [-8, 0, 8.5], Math.PI / 2, (on) => {
      settings.sound = on;
      saveSettings();
      this.refreshLabels();
    });
    soundLever.on = settings.sound;
    this.soundLabel = { pos: [-8, 2.3, 8.5], text: '', size: 0.26, color: '#ffd166' };

    this.startLabel = { pos: [WALL, 3.05, 0], text: '', size: 0.26, color: '#e7c6ff' };
    this.fixedLabels.push(
      { pos: [WALL, 3.6, 0], text: 'START', size: 0.8, color: '#f0d9ff' },
      { pos: [0, 7.2, -WALL], text: 'THE CHAMBER', size: 2.2 },
      { pos: [0, 5.75, -WALL], text: 'Aperture-adjacent. Legally distinct.', size: 0.6 },
      { pos: [-WALL, 4.9, 0], text: 'WASD walk · Shift sprint · Space jump', size: 0.5 },
      { pos: [-WALL, 4.1, 0], text: 'E use · Hold click carry · Right-click throw · Esc pause', size: 0.5 },
    );
    this.allLabels = [...this.fixedLabels, this.startLabel, this.mouseLabel, this.invertLabel, this.soundLabel];
    this.refreshLabels();

    // Something to fling around while you make up your mind.
    for (let i = 0; i < 4; i++) {
      const def = junk(i % 2 ? 'small crate' : 'crate');
      spawnJunk(physics, def, [4 + i * 1.3, def.size[1] / 2 + 0.01, 5.5 + (i % 2) * 1.5]);
    }
    spawnJunk(physics, junk('beach ball'), [3, 0.4, 3]);
    spawnJunk(physics, junk('rubber duck'), [1.5, 0.3, 3.5]);
  }

  private pickLevel(n: number) {
    settings.startLevel = n;
    saveSettings();
    this.levelButtons.forEach((b, i) => (b.color = i + 1 === n ? SELECTED : UNSELECTED));
    this.refreshLabels();
  }

  private changeMouse(factor: number) {
    settings.mouseSpeed = Math.min(MOUSE_MAX, Math.max(MOUSE_MIN, Math.round(settings.mouseSpeed * factor * 20) / 20));
    saveSettings();
    this.refreshLabels();
  }

  private refreshLabels() {
    if (!this.startLabel) return;
    this.startLabel.text = `→ LEVEL ${settings.startLevel}`;
    this.mouseLabel.text = `MOUSE SPEED ${settings.mouseSpeed.toFixed(2)}×`;
    this.invertLabel.text = `INVERT LOOK: ${settings.invertY ? 'ON' : 'OFF'}`;
    this.soundLabel.text = settings.sound ? 'SOUND: ON' : 'SOUND: BLISSFULLY OFF';
  }

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered) this.status = 'exited';
    this.afk.update(dt, this.arrival.done && this.status === 'playing');
    // The only way to die in the lobby is to leave your character unattended near a grenade.
    if (player.mode === 'ragdoll' && this.status === 'playing') {
      this.deadFor += dt;
      if (this.deadFor > 1.5) {
        this.status = 'lost';
        hud.show('AWAY FROM KEYBOARD', 'Permanently, now.\nPress R to respawn.');
        hud.tips([
          ['Hint', 'Idle hands get handed grenades. Wiggle the mouse now and then.'],
          ['Controls', 'R respawns you. Literally any key proves you are alive.'],
        ]);
      }
    }
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    this.afk.draw(out);
  }

  labels(): WorldLabel[] {
    return this.allLabels;
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

