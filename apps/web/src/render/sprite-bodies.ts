/**
 * Body-plan silhouettes built from simple primitives in chibi proportions. Palette roles:
 * primary = main body, secondary = clothing or second material, accent = trims and eyes, detail = small bits.
 * Each routine draws the body and its head (with default eyes) facing right on the 48 x 64 canvas.
 */
import type { BodyPlan } from "@aedm/schemas";
import { OUTLINE } from "./palette";
import type { Pen } from "./px";
import type { Anchors } from "./sprite-anchors";
import { chain, type Pal } from "./sprite-kit";

export interface BodyCtx { p: Pen; a: Anchors; pal: Pal; frame: number }

const eye = (p: Pen, x: number, y: number, w = 2, h = 3): void => {
  p.rect(x, y, w, h, OUTLINE);
  p.px(x, y, "#fff8e8");
};

export const BODY_DRAWERS: Record<BodyPlan, (c: BodyCtx) => void> = {
  humanoid({ p, a, pal }) {
    const { primary: pr, secondary: sec, accent: ac, detail: de } = pal;
    // legs and boots
    p.box(17, 46, 6, 12, sec); p.box(26, 46, 6, 12, sec);
    p.box(15, 56, 9, 4, de); p.box(25, 56, 9, 4, de);
    // arms behind, then torso
    p.rrect(9, 33, 7, 12, 3, sec.sh); p.rrect(32, 33, 7, 12, 3, sec.sh);
    p.rrect(9, 33, 6, 11, 3, sec.base);
    p.rrect(33, 33, 6, 11, 3, sec.sh);
    p.blob(a.handL.x, a.handL.y, 3.4, 3.4, pr); p.blob(a.handR.x, a.handR.y, 3.4, 3.4, pr);
    p.rrect(15, 30, 18, 18, 4, sec.sh);
    p.rrect(15, 30, 16, 17, 4, sec.base);
    p.rect(17, 32, 3, 8, sec.hi);
    p.rect(15, 42, 18, 3, ac.base); p.rect(15, 42, 18, 1, ac.hi);
    p.rect(22, 42, 4, 3, ac.hi); p.px(23, 43, ac.dk);
    // head
    p.rect(21, 28, 6, 4, pr.sh);
    p.blob(24, 18, 12, 12, pr);
    p.rect(15, 24, 3, 2, pr.hi);
    // hair
    p.ell(24, 12, 12, 7.5, de.sh);
    p.ell(23.5, 11.5, 11, 6.5, de.base);
    p.rect(14, 8, 7, 2, de.hi);
    p.rect(13, 13, 3, 5, de.sh); p.rect(32, 13, 3, 5, de.sh);
    p.rect(17, 13, 14, 2, de.base);
    for (const e of a.eyes) eye(p, e.x, e.y);
    p.rect(26, 24, 2, 1, pr.dk);
    p.rect(18, 23, 2, 1, ac.base); p.rect(30, 23, 2, 1, ac.base);
  },

  beast({ p, pal, frame }) {
    const { primary: pr, secondary: sec, detail: de } = pal;
    const bob = frame ? 1 : 0;
    // far legs
    p.box(12, 50, 5, 9, pr); p.rect(12, 50, 5, 9, pr.sh);
    p.box(29, 50, 5, 9, pr); p.rect(29, 50, 5, 9, pr.sh);
    p.rect(11, 57, 7, 3, de.sh); p.rect(28, 57, 7, 3, de.sh);
    // body and neck
    p.blob(20, 43, 15, 10, pr);
    p.ell(21, 48, 10, 4, sec.base); p.rect(15, 46, 8, 1, sec.hi);
    p.blob(30, 38, 7, 7, pr);
    // near legs
    p.box(7, 49, 6, 10, pr); p.box(24, 49, 6, 10, pr);
    p.rect(6, 57, 8, 3, de.base); p.rect(23, 57, 8, 3, de.base);
    p.rect(6, 57, 8, 1, de.hi); p.rect(23, 57, 8, 1, de.hi);
    // head
    p.poly([[31, 26], [33, 19 + bob], [37, 25]], pr.sh); p.poly([[36, 25], [40, 18 + bob], [42, 26]], pr.base);
    p.rect(40, 21 + bob, 1, 3, pr.sh);
    p.blob(36, 31, 9, 8, pr);
    p.blob(42, 35, 5.5, 4.2, sec);
    p.rect(45, 33, 3, 2, OUTLINE);
    eye(p, 38, 28);
    p.rect(40, 38, 4, 1, pr.dk);
  },

  avian({ p, a, pal }) {
    const { primary: pr, secondary: sec, accent: ac, detail: de } = pal;
    p.line(21, 52, 21, 58, de.base, 2); p.line(28, 52, 28, 58, de.base, 2);
    p.rect(17, 58, 7, 2, ac.base); p.rect(26, 58, 7, 2, ac.base);
    p.poly([[11, 44], [1, 52], [4, 58], [12, 54]], sec.sh);
    p.poly([[11, 44], [3, 52], [12, 52]], sec.base);
    p.blob(23, 42, 13, 14, pr);
    p.ell(27, 46, 8, 9, sec.base); p.rect(22, 38, 3, 4, sec.hi);
    p.blob(15, 43, 6, 10, sec);
    p.rect(11, 40, 1, 6, sec.dk); p.rect(14, 44, 1, 7, sec.dk);
    p.poly([[22, 14], [24, 6], [27, 13]], ac.base);
    p.blob(28, 21, 9, 9, pr);
    p.poly([[34, 19], [44, 23], [34, 27]], ac.sh);
    p.poly([[34, 19], [44, 23], [34, 23]], ac.base);
    eye(p, a.eyes[0]!.x, a.eyes[0]!.y);
  },

  serpent({ p, a, pal, frame }) {
    const { primary: pr, secondary: sec, accent: ac } = pal;
    const w = frame ? 1 : 0;
    const body = [{ x: 5, y: 56 }, { x: 11, y: 58 }, { x: 18, y: 58 }, { x: 25, y: 55 }, { x: 30, y: 50 }, { x: 31, y: 43 - w }, { x: 27, y: 37 }, { x: 28, y: 31 }, { x: 33, y: 27 }];
    chain(p, body, 2.2, 6.2, pr, 1.4);
    // belly bands
    p.atop(() => {
      for (let i = 2; i < body.length; i++) p.ell(body[i]!.x - 1, body[i]!.y + 1, 3, 3, sec.base);
    });
    p.blob(36, 22, 9, 7.5, pr);
    p.rect(30, 26, 12, 2, sec.base);
    eye(p, a.eyes[0]!.x, a.eyes[0]!.y);
    p.rect(44, 23, 3, 1, ac.base); p.px(47, 22, ac.base); p.px(47, 24, ac.base);
    p.rect(41, 27, 3, 1, pr.dk);
  },

  insectoid({ p, a, pal, frame }) {
    const { primary: pr, secondary: sec, accent: ac, detail: de } = pal;
    const k = frame ? 1 : 0;
    const leg = (bx: number, i: number, far: boolean) => {
      const dx = far ? 4 : 0, dy = far ? -2 : 0;
      const kx = bx - 6 + i * 3 + dx, ky = 50 + dy - (i === 1 ? k : 0);
      const fx = bx - 7 + i * 5 + dx, fy = 59 + dy * 0;
      p.line(bx + dx, 45 + dy, kx, ky, far ? de.sh : de.dk, 3);
      p.line(kx, ky, fx, fy, far ? de.sh : de.dk, 3);
      p.line(bx + dx, 45 + dy, kx, ky, far ? de.base : de.base, 1);
      p.line(kx, ky, fx, fy, far ? de.base : de.hi, 1);
    };
    for (let i = 0; i < 3; i++) leg(15 + i * 6, i, true);
    p.blob(10, 41, 9.5, 8, pr);
    p.atop(() => { p.rect(6, 30, 2, 20, sec.base); p.rect(11, 30, 2, 20, sec.base); });
    p.blob(22, 40, 8.5, 7.5, pr);
    for (let i = 0; i < 3; i++) leg(14 + i * 6, i, false);
    p.rect(20, 37, 4, 1, pr.hi);
    p.blob(35, 37, 7.5, 7, pr);
    p.line(37, 31, 39, 23 - k, de.base, 1); p.line(39, 23 - k, 42, 22 - k, de.base, 1);
    p.line(33, 31, 33, 24 - k, de.base, 1); p.line(33, 24 - k, 36, 22 - k, de.base, 1);
    p.ell(37, 35, 3.5, 3.5, OUTLINE); p.ell(37, 35, 2.8, 2.8, ac.base); p.rect(36, 34, 1, 1, ac.hi);
    p.poly([[40, 40], [44, 38], [43, 43]], de.base);
    p.px(a.eyes[0]!.x, a.eyes[0]!.y, ac.hi);
  },

  amorphous({ p, a, pal, frame }) {
    const { primary: pr, secondary: sec, accent: ac } = pal;
    const d = frame ? 1 : 0;
    p.blob(24, 47, 18, 12, pr);
    p.blob(15, 43, 9, 8, pr);
    p.blob(32, 41, 8.5, 8, pr);
    p.ell(28, 50, 6, 4.5, sec.sh); p.ell(27, 49.5, 5, 3.6, sec.base); p.rect(25, 48, 2, 1, sec.hi);
    p.ell(10, 59 + d, 2.4, 3, pr.sh); p.ell(10, 58 + d, 1.6, 2, pr.base);
    p.ell(37, 58 + d, 2, 3, pr.sh); p.ell(37, 57 + d, 1.2, 2, pr.base);
    p.px(19, 53, ac.base); p.px(30, 44, ac.base); p.px(13, 48, ac.hi);
    for (const e of a.eyes) { p.rect(e.x - 1, e.y - 1, 4, 5, OUTLINE); p.rect(e.x, e.y, 2, 3, "#fff8e8"); p.px(e.x + 1, e.y + 2, OUTLINE); }
    p.rect(22, 47, 5, 1, pr.dk);
  },

  construct({ p, a, pal }) {
    const { primary: pr, secondary: sec, accent: ac, detail: de } = pal;
    p.box(14, 48, 9, 10, sec); p.box(25, 48, 9, 10, sec);
    p.box(13, 57, 11, 3, de); p.box(24, 57, 11, 3, de);
    p.box(5, 29, 7, 16, pr); p.box(36, 29, 7, 16, pr);
    p.box(4, 44, 9, 6, de); p.box(35, 44, 9, 6, de);
    p.box(12, 27, 24, 21, pr);
    p.box(16, 31, 16, 11, sec);
    p.rect(22, 34, 5, 5, OUTLINE); p.rect(23, 35, 3, 3, ac.base); p.px(23, 35, ac.hi);
    for (const [x, y] of [[13, 28], [34, 28], [13, 45], [34, 45], [17, 32], [30, 32]] as const) p.px(x, y, de.hi);
    p.rect(12, 44, 24, 2, pr.sh);
    p.rect(20, 25, 8, 3, de.sh);
    p.box(14, 6, 20, 19, pr);
    p.rect(16, 11, 16, 6, OUTLINE);
    p.rect(17, 12, 14, 4, ac.sh);
    for (const e of a.eyes) { p.rect(e.x, e.y - 1, 3, 3, ac.hi); }
    p.px(15, 8, de.hi); p.px(32, 8, de.hi); p.px(15, 22, de.hi); p.px(32, 22, de.hi);
    p.rect(22, 3, 4, 3, de.base); p.rect(23, 1, 2, 2, ac.base);
    p.rect(20, 20, 8, 2, pr.dk);
  },

  spirit({ p, a, pal, frame }) {
    const { primary: pr, secondary: sec, accent: ac } = pal;
    const s = frame ? 1 : 0;
    p.blob(24 + s, 48, 9, 8, pr);
    p.blob(26 - s, 53, 7, 6, sec);
    p.blob(23 + s, 57, 5, 4, pr);
    p.ell(25 - s, 60, 2.5, 2, sec.base);
    p.blob(24, 38, 10, 10, pr);
    p.blob(12, 41 + s, 4.5, 7, pr); p.blob(36, 41 - s, 4.5, 7, pr);
    p.ell(11, 48 + s, 2.6, 3, sec.base); p.ell(37, 48 - s, 2.6, 3, sec.base);
    p.blob(24, 21, 11, 11, pr);
    p.rect(17, 12, 4, 2, pr.hi);
    for (const e of a.eyes) { p.ell(e.x, e.y, 2.8, 3.8, OUTLINE); p.px(e.x, e.y, ac.hi); p.px(e.x, e.y + 1, ac.base); }
    p.rect(22, 29, 5, 2, OUTLINE);
  },

  plant({ p, a, pal, frame }) {
    const { primary: pr, secondary: sec, accent: ac, detail: de } = pal;
    const sw = frame ? 1 : 0;
    p.poly([[10, 60], [17, 50], [31, 50], [39, 60]], de.sh);
    p.poly([[14, 60], [19, 52], [29, 52], [34, 60]], de.base);
    p.box(16, 30, 16, 25, sec);
    for (const x of [20, 24, 28]) p.rect(x, 33, 1, 20 - (x % 3), sec.dk);
    p.rect(17, 31, 2, 22, sec.hi);
    p.line(16, 38, 8, 31 - sw, sec.dk, 4); p.line(16, 38, 8, 31 - sw, sec.base, 2);
    p.line(32, 39, 41, 33 + sw, sec.dk, 4); p.line(32, 39, 41, 33 + sw, sec.sh, 2);
    p.blob(7, 29 - sw, 4.5, 4, pr); p.blob(41, 31 + sw, 4.5, 4, pr);
    for (const e of a.eyes) { p.rect(e.x - 1, e.y - 1, 4, 5, OUTLINE); p.rect(e.x, e.y, 2, 3, ac.base); p.px(e.x, e.y, ac.hi); }
    p.rect(22, 44, 5, 1, sec.dk); p.rect(21, 43, 1, 1, sec.dk); p.rect(27, 43, 1, 1, sec.dk);
    p.blob(24, 13, 13, 10, pr); p.blob(12, 20, 9, 8, pr); p.blob(36, 20, 9, 8, pr); p.blob(24, 22, 12, 7, pr);
    for (const [x, y] of [[15, 12], [30, 10], [22, 18], [34, 22], [12, 24]] as const) p.rect(x, y, 2, 2, pr.hi);
    for (const [x, y] of [[20, 8], [27, 17], [17, 22]] as const) p.rect(x, y, 2, 2, pr.dk);
  },

  object({ p, a, pal, frame }) {
    const { primary: pr, secondary: sec, accent: ac, detail: de } = pal;
    const t = frame ? 0 : 0;
    p.rect(9, 34 + t, 30, 25, pr.dk);
    p.rect(10, 35, 28, 23, pr.base);
    p.rect(10, 35, 3, 23, pr.hi);
    p.rect(35, 35, 3, 23, pr.sh);
    p.rect(10, 54, 28, 4, pr.sh);
    p.poly([[9, 34], [14, 25], [34, 25], [39, 34]], pr.dk);
    p.poly([[11, 33], [15, 26], [33, 26], [37, 33]], pr.hi);
    p.rect(10, 34, 28, 3, sec.sh); p.rect(10, 34, 28, 1, sec.hi);
    p.rect(10, 44, 28, 3, sec.base); p.rect(10, 44, 28, 1, sec.hi);
    p.rect(21, 41, 6, 8, de.sh); p.rect(22, 42, 4, 6, de.base); p.rect(23, 44, 2, 3, OUTLINE);
    p.px(11, 36, de.hi); p.px(36, 36, de.hi); p.px(11, 55, de.hi); p.px(36, 55, de.hi);
    void ac; void a;
  },
};
