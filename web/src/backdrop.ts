/**
 * 背景动态渲染：缓慢漂移的等高线 + 低密度工业尘埃。
 *
 * 单独的固定 canvas，位于页面内容之后（z-index:-1），不拦截指针。
 * 只有一帧绘制循环；窗口隐藏、系统减少动态效果时暂停/退化为静态一帧。
 * 颜色取自 endfield-ui 的 --ef-ink / --ef-ink-2，跟随深浅主题。
 */

interface Dust {
  /** 归一化坐标 (0..1)。 */
  x: number;
  y: number;
  /** 归一化速度 (每秒)。 */
  vx: number;
  vy: number;
  /** 半径 (CSS px)。 */
  r: number;
  /** 透明度相位，制造明暗呼吸。 */
  phase: number;
  alpha: number;
}

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const MAX_DPR = 1.5;

/** 从根元素读取 CSS 颜色；缺失时使用回退值。 */
function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/** 画一组缓慢呼吸的等高线（只出现在画面两角，避免干扰读数）。 */
function drawContours(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  parallaxX: number,
  parallaxY: number,
  ink: string,
  isDark: boolean
): void {
  const scale = Math.min(width, height);
  const clusters = [
    { cx: width * 0.93, cy: height * 0.10, base: scale * 0.105 },
    { cx: width * 0.05, cy: height * 0.90, base: scale * 0.085 },
  ];
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.globalAlpha = isDark ? 0.1 : 0.075;
  ctx.lineWidth = 1;
  for (let c = 0; c < clusters.length; c += 1) {
    const cluster = clusters[c];
    const phase = c === 0 ? 0.6 : 2.4;
    for (let ring = 0; ring < 5; ring += 1) {
      /* 环间距大于相邻环的最大摆动差，保证轮廓永不粘连、始终留出细小间隙 */
      const base = cluster.base + ring * cluster.base * 0.26;
      ctx.beginPath();
      for (let step = 0; step <= 96; step += 1) {
        const angle = (step / 96) * Math.PI * 2;
        /* 多正弦叠加：振幅按簇基数固定（最大 0.08×基数），
           环间距 0.26×基数，理论最小间隙仍有 0.10×基数，不会粘连 */
        const wobble =
          Math.sin(angle * 3 + time * 0.13 + phase + ring * 0.7) * cluster.base * 0.05 +
          Math.cos(angle * 5 - time * 0.09 + phase * 0.7 + ring) * cluster.base * 0.03;
        const radius = base + wobble;
        const x = cluster.cx + Math.cos(angle) * radius + parallaxX;
        const y = cluster.cy + Math.sin(angle) * radius * 0.78 + parallaxY;
        if (step === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 画低密度尘埃；偶尔出现短划痕，增加工业感。 */
function drawDust(
  ctx: CanvasRenderingContext2D,
  particles: readonly Dust[],
  width: number,
  height: number,
  time: number,
  parallaxX: number,
  parallaxY: number,
  ink2: string
): void {
  ctx.save();
  ctx.fillStyle = ink2;
  for (const particle of particles) {
    const breath = 0.72 + Math.sin(time * 0.7 + particle.phase) * 0.28;
    ctx.globalAlpha = particle.alpha * breath;
    const x = particle.x * width + parallaxX * 1.8;
    const y = particle.y * height + parallaxY * 1.8;
    if (particle.r > 1.2) {
      /* 少量细划痕：像远处的金属屑 */
      ctx.fillRect(x, y, particle.r * 2.4, 0.6);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, particle.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

class Backdrop {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private ink = '#161616';
  private ink2 = '#5c5c5c';
  private isDark = false;
  private reduced = false;
  private time = 0;
  private lastFrame = 0;
  private frame = 0;
  private running = false;
  private particles: Dust[] = [];
  private pointerX = 0;
  private pointerY = 0;
  private targetX = 0;
  private targetY = 0;
  private readonly reducedQuery = window.matchMedia(REDUCED_QUERY);
  private readonly darkQuery = window.matchMedia(DARK_QUERY);

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.reduced = this.reducedQuery.matches;
    this.isDark = this.darkQuery.matches;
    this.refreshPalette();
    this.resize();
  }

  start(): void {
    /* 没有 canvas 上下文时保留 CSS 静态等高线作为降级 */
    document.body.classList.add('ef-fx');
    this.reducedQuery.addEventListener('change', this.onMotionChange);
    this.darkQuery.addEventListener('change', this.onThemeChange);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (this.reduced || document.hidden) this.draw(0);
    else this.loop(0);
  }

  private readonly onMotionChange = (): void => {
    this.reduced = this.reducedQuery.matches;
    if (this.reduced) {
      this.stop();
      this.draw(0);
    } else {
      this.loop(performance.now());
    }
  };

  private readonly onThemeChange = (): void => {
    this.isDark = this.darkQuery.matches;
    this.refreshPalette();
    if (this.reduced) this.draw(0);
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stop();
    } else if (!this.reduced) {
      this.loop(performance.now());
    }
  };

  private readonly onResize = (): void => {
    this.resize();
    if (this.reduced) this.draw(0);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.targetX = (event.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
    this.targetY = (event.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
  };

  private refreshPalette(): void {
    this.ink = cssColor('--ef-ink', this.isDark ? '#ededed' : '#161616');
    this.ink2 = cssColor('--ef-ink-2', this.isDark ? '#a3a3a3' : '#5c5c5c');
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width) || window.innerWidth);
    const height = Math.max(1, Math.round(rect.height) || window.innerHeight);
    this.dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.particles = this.createParticles(width);
    this.draw(this.time);
  }

  private createParticles(width: number): Dust[] {
    const count = width < 720 ? 24 : 64;
    return Array.from({ length: count }, (_, index) => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.006,
      vy: -(0.004 + Math.random() * 0.01),
      r: index % 9 === 0 ? 1.4 : 0.5 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.1 + Math.random() * 0.2,
    }));
  }

  private loop(now: number): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = now;
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    this.running = false;
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    const delta = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.time += delta;
    const speed = document.documentElement.dataset.efMotion === 'calm' ? 0.65 : 1;
    this.pointerX += (this.targetX - this.pointerX) * 0.035;
    this.pointerY += (this.targetY - this.pointerY) * 0.035;
    for (const particle of this.particles) {
      particle.x += particle.vx * delta * speed;
      particle.y += particle.vy * delta * speed;
      if (particle.x < -0.02) particle.x = 1.02;
      if (particle.x > 1.02) particle.x = -0.02;
      if (particle.y < -0.02) particle.y = 1.02;
      if (particle.y > 1.02) particle.y = -0.02;
    }
    this.draw(this.time);
    this.frame = requestAnimationFrame(this.tick);
  };

  private draw(time: number): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    drawContours(
      this.ctx,
      this.width,
      this.height,
      time,
      this.pointerX * 5,
      this.pointerY * 4,
      this.ink,
      this.isDark
    );
    drawDust(
      this.ctx,
      this.particles,
      this.width,
      this.height,
      time,
      this.pointerX * 4,
      this.pointerY * 3,
      this.ink2
    );
  }
}

let backdrop: Backdrop | null = null;

/** 初始化背景 canvas；重复调用为空操作。 */
export function initBackdrop(): void {
  if (backdrop !== null) return;
  const canvas = document.getElementById('fxBackdrop');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  backdrop = new Backdrop(canvas, ctx);
  backdrop.start();
}
