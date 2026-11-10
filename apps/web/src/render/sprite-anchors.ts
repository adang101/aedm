/**
 * Anchor points per body plan on the 48 x 64 sprite canvas (feet on y = 60, neck anchor (24, 32) for the
 * humanoid). Every part routine is placed relative to these, so a part works on any body plan.
 * All sprites are drawn facing right; facing left mirrors the finished canvas.
 */
import type { BodyPlan, SpritePose } from "@aedm/schemas";

export interface Pt { x: number; y: number }
export interface Ell { cx: number; cy: number; rx: number; ry: number }

export interface Anchors {
  body: BodyPlan;
  head: Ell;
  headTop: Pt;
  /** Front of the face (where a beard, mask or beak starts). */
  headFront: Pt;
  neck: Pt;
  /** Visible eyes, left to right. */
  eyes: Pt[];
  /** Main mass: chest for a humanoid, flank for a beast, trunk for a plant. */
  torso: Ell;
  /** Trapezoid clothing covers: from `top` to `hem`, `halfTop` and `halfHem` wide around `cx`. */
  garment: { top: number; hem: number; cx: number; halfTop: number; halfHem: number };
  /** Between the shoulder blades: wings, cloaks and shells attach here. */
  back: Pt;
  handL: Pt;
  handR: Pt;
  tailBase: Pt;
  /** Ellipse that encloses the whole creature, for auras. */
  aura: Ell;
}

export const FEET_Y = 60;
export const NECK: Pt = { x: 24, y: 32 };

const e = (cx: number, cy: number, rx: number, ry: number): Ell => ({ cx, cy, rx, ry });
const p = (x: number, y: number): Pt => ({ x, y });

const TABLE: Record<BodyPlan, Anchors> = {
  humanoid: {
    body: "humanoid", head: e(24, 18, 12, 12), headTop: p(24, 6), headFront: p(33, 21), neck: NECK,
    eyes: [p(21, 19), p(28, 19)], torso: e(24, 39, 9, 9),
    garment: { top: 31, hem: 57, cx: 24, halfTop: 9, halfHem: 13 },
    back: p(24, 38), handL: p(12, 45), handR: p(37, 45), tailBase: p(19, 52), aura: e(24, 34, 22, 27),
  },
  beast: {
    body: "beast", head: e(36, 31, 9, 8), headTop: p(35, 23), headFront: p(44, 34), neck: p(29, 37),
    eyes: [p(39, 29), p(44, 29)], torso: e(20, 44, 15, 10),
    garment: { top: 35, hem: 55, cx: 20, halfTop: 12, halfHem: 15 },
    back: p(20, 36), handL: p(11, 52), handR: p(41, 49), tailBase: p(6, 42), aura: e(24, 43, 23, 21),
  },
  avian: {
    body: "avian", head: e(28, 21, 9, 9), headTop: p(27, 12), headFront: p(36, 23), neck: p(25, 30),
    eyes: [p(31, 19)], torso: e(23, 42, 13, 14),
    garment: { top: 32, hem: 56, cx: 23, halfTop: 10, halfHem: 12 },
    back: p(16, 40), handL: p(13, 50), handR: p(35, 50), tailBase: p(9, 50), aura: e(24, 38, 22, 25),
  },
  serpent: {
    body: "serpent", head: e(36, 22, 8, 7), headTop: p(36, 15), headFront: p(44, 23), neck: p(33, 29),
    eyes: [p(39, 19)], torso: e(22, 46, 15, 10),
    garment: { top: 38, hem: 56, cx: 23, halfTop: 11, halfHem: 15 },
    back: p(24, 40), handL: p(7, 50), handR: p(42, 36), tailBase: p(6, 55), aura: e(24, 38, 22, 24),
  },
  insectoid: {
    body: "insectoid", head: e(35, 37, 7, 7), headTop: p(35, 30), headFront: p(42, 39), neck: p(30, 39),
    eyes: [p(37, 35)], torso: e(22, 41, 10, 8),
    garment: { top: 35, hem: 54, cx: 20, halfTop: 12, halfHem: 14 },
    back: p(22, 36), handL: p(14, 49), handR: p(40, 47), tailBase: p(4, 43), aura: e(24, 42, 23, 19),
  },
  amorphous: {
    body: "amorphous", head: e(24, 38, 13, 10), headTop: p(24, 28), headFront: p(34, 43), neck: p(24, 48),
    eyes: [p(19, 41), p(28, 41)], torso: e(24, 48, 18, 12),
    garment: { top: 40, hem: 58, cx: 24, halfTop: 14, halfHem: 18 },
    back: p(24, 42), handL: p(8, 50), handR: p(40, 50), tailBase: p(10, 57), aura: e(24, 46, 23, 17),
  },
  construct: {
    body: "construct", head: e(24, 15, 10, 9), headTop: p(24, 6), headFront: p(34, 16), neck: p(24, 26),
    eyes: [p(20, 14), p(27, 14)], torso: e(24, 37, 12, 11),
    garment: { top: 28, hem: 56, cx: 24, halfTop: 12, halfHem: 14 },
    back: p(24, 36), handL: p(8, 49), handR: p(40, 49), tailBase: p(20, 52), aura: e(24, 34, 23, 28),
  },
  spirit: {
    body: "spirit", head: e(24, 21, 11, 11), headTop: p(24, 10), headFront: p(33, 23), neck: p(24, 31),
    eyes: [p(20, 21), p(28, 21)], torso: e(24, 38, 10, 8),
    garment: { top: 32, hem: 59, cx: 24, halfTop: 10, halfHem: 8 },
    back: p(24, 38), handL: p(10, 46), handR: p(38, 46), tailBase: p(24, 52), aura: e(24, 36, 22, 26),
  },
  plant: {
    body: "plant", head: e(24, 16, 15, 12), headTop: p(24, 4), headFront: p(34, 24), neck: p(24, 30),
    eyes: [p(20, 37), p(27, 37)], torso: e(24, 44, 8, 14),
    garment: { top: 34, hem: 58, cx: 24, halfTop: 8, halfHem: 10 },
    back: p(24, 40), handL: p(8, 34), handR: p(41, 35), tailBase: p(24, 56), aura: e(24, 34, 22, 29),
  },
  object: {
    body: "object", head: e(24, 31, 13, 7), headTop: p(24, 25), headFront: p(35, 35), neck: p(24, 38),
    eyes: [p(18, 45), p(29, 45)], torso: e(24, 46, 14, 12),
    garment: { top: 36, hem: 58, cx: 24, halfTop: 13, halfHem: 14 },
    back: p(24, 44), handL: p(8, 50), handR: p(40, 50), tailBase: p(10, 56), aura: e(24, 42, 23, 22),
  },
};

/** Anchors for a body plan, adjusted for the pose (an aggressive pose raises and pushes forward the right hand). */
export function anchorsFor(body: BodyPlan, pose: SpritePose = "idle"): Anchors {
  const a = TABLE[body];
  if (pose !== "aggressive") return a;
  return { ...a, handR: p(a.handR.x + 2, a.handR.y - 8) };
}

/** Size multipliers from the content spec. */
export const SIZE_SCALE = { tiny: 0.6, small: 0.8, medium: 1, large: 1.3, huge: 1.6 } as const;
