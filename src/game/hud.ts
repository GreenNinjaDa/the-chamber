const STYLE = `
.hud { position: fixed; inset: 0; pointer-events: none; color: #fff;
       font-family: "Segoe UI", system-ui, sans-serif; text-shadow: 0 2px 8px rgba(0,0,0,.6); }
.hud-level { position: absolute; top: 16px; left: 20px; font-size: 14px; letter-spacing: .2em;
             text-transform: uppercase; opacity: .85; }
.hud-fps { position: absolute; top: 16px; right: 20px; font-size: 12px; opacity: .6; font-variant-numeric: tabular-nums; }
.hud-center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
              transition: opacity .4s; padding: 16px; }
.hud-big { font-size: clamp(40px, 9vw, 96px); font-weight: 800; letter-spacing: .12em; }
.hud-small { font-size: clamp(14px, 2vw, 20px); margin-top: 8px; opacity: .9; white-space: pre-line; line-height: 1.5; }
.hud-cross { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
              border-radius: 50%; background: #fff; box-shadow: 0 0 0 1.5px rgba(0,0,0,.45);
              transition: width .12s, height .12s, margin .12s, background .12s, opacity .2s; box-sizing: border-box; }
.hud-cross.target { width: 22px; height: 22px; margin: -11px 0 0 -11px; background: transparent; border: 2px solid #fff; }
.hud-cross.holding { width: 14px; height: 14px; margin: -7px 0 0 -7px; background: rgba(255,255,255,.35); border: 2px solid #fff; }
.hud-cross.hidden { opacity: 0; }
.hud-marker { position: absolute; left: 0; top: 0; pointer-events: none; }
.hud-ring { position: absolute; border: 2px solid #ff2a1a; border-radius: 50%; box-sizing: border-box;
            box-shadow: 0 0 8px rgba(255,40,20,.8), inset 0 0 6px rgba(255,40,20,.5);
            animation: hud-pulse .55s ease-in-out infinite; }
.hud-arrow { position: absolute; width: 34px; height: 28px; margin: -14px 0 0 -17px; }
.hud-arrow > div { width: 100%; height: 100%; background: #ff2a1a; clip-path: polygon(100% 50%, 0 0, 22% 50%, 0 100%);
                   filter: drop-shadow(0 0 6px rgba(255,40,20,.9)); animation: hud-pulse .55s ease-in-out infinite; }
@keyframes hud-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: .3; } }
.hud-hint { position: absolute; bottom: 28px; left: 0; right: 0; text-align: center; font-size: 18px;
            padding: 0 16px; transition: opacity .3s; }
`;

export interface ScreenMarker {
  onScreen: boolean;
  x: number;
  y: number;
  /** Ring diameter (px), when on screen. */
  size: number;
  /** Arrow direction (radians, screen space, 0 = right), when off screen. */
  angle: number;
}

/** DOM overlay for level titles, messages and hints. */
export class Hud {
  private levelEl: HTMLDivElement;
  private fpsEl: HTMLDivElement;
  private centerEl: HTMLDivElement;
  private bigEl: HTMLDivElement;
  private smallEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private crossEl: HTMLDivElement;
  private markerRoot: HTMLDivElement;
  private markerPool: { ring: HTMLDivElement; arrow: HTMLDivElement }[] = [];
  private messageTimer = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const root = el('hud');
    this.levelEl = el('hud-level');
    this.fpsEl = el('hud-fps');
    this.centerEl = el('hud-center');
    this.bigEl = el('hud-big');
    this.smallEl = el('hud-small');
    this.hintEl = el('hud-hint');
    this.crossEl = el('hud-cross hidden');
    this.markerRoot = el('hud-marker');
    this.centerEl.append(this.bigEl, this.smallEl);
    root.append(this.markerRoot, this.levelEl, this.fpsEl, this.crossEl, this.centerEl, this.hintEl);
    document.body.appendChild(root);
    this.hide();
  }

  setLevel(text: string) {
    this.levelEl.textContent = text;
  }

  /** Shows a centred message; with a duration it fades out on its own. */
  show(big: string, small = '', duration = 0) {
    this.bigEl.textContent = big;
    this.smallEl.textContent = small;
    this.centerEl.style.opacity = '1';
    this.messageTimer = duration;
  }

  hide() {
    this.centerEl.style.opacity = '0';
    this.messageTimer = 0;
  }

  crosshair(state: 'hidden' | 'idle' | 'target' | 'holding') {
    const cls = `hud-cross ${state === 'idle' ? '' : state}`.trim();
    if (this.crossEl.className !== cls) this.crossEl.className = cls;
  }

  /**
   * Shows a pulsing ring around each on-screen target (x, y, diameter in px) and an arrow at the
   * screen edge for each off-screen one (angle in radians, 0 = pointing right).
   */
  markers(list: ScreenMarker[]) {
    while (this.markerPool.length < list.length) {
      const ring = el('hud-ring'), arrow = el('hud-arrow');
      arrow.appendChild(document.createElement('div'));
      this.markerRoot.append(ring, arrow);
      this.markerPool.push({ ring, arrow });
    }
    this.markerPool.forEach((m, i) => {
      const t = list[i];
      m.ring.style.display = t?.onScreen ? 'block' : 'none';
      m.arrow.style.display = t && !t.onScreen ? 'block' : 'none';
      if (!t) return;
      if (t.onScreen) {
        const d = Math.round(t.size);
        m.ring.style.width = m.ring.style.height = `${d}px`;
        m.ring.style.left = `${Math.round(t.x - d / 2)}px`;
        m.ring.style.top = `${Math.round(t.y - d / 2)}px`;
      } else {
        m.arrow.style.left = `${Math.round(t.x)}px`;
        m.arrow.style.top = `${Math.round(t.y)}px`;
        m.arrow.style.transform = `rotate(${t.angle}rad)`;
      }
    });
  }

  hint(text: string) {
    this.hintEl.textContent = text;
    this.hintEl.style.opacity = text ? '1' : '0';
  }

  update(dt: number) {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.hide();
    }
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAccum)} fps`;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }
}

function el(className: string) {
  const d = document.createElement('div');
  d.className = className;
  return d;
}
