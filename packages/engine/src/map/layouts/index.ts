import type { Environment, Layout } from "@aedm/schemas";
import { T } from "./grid";
import type { LayoutFn, Terrain } from "./grid";
import { arena } from "./arena";
import { cave } from "./cave";
import { islands } from "./islands";
import { maze } from "./maze";
import { openField } from "./open-field";
import { roomsAndCorridors } from "./rooms-and-corridors";
import { settlement } from "./settlement";
import { trail } from "./trail";

export const LAYOUT_GENERATORS: Readonly<Record<Layout, LayoutFn>> = {
  rooms_and_corridors: roomsAndCorridors,
  cave,
  open_field: openField,
  settlement,
  trail,
  arena,
  maze,
  islands,
};

/** What fills the map edge: outdoor open layouts end in obstacles (islands in sea); built and underground layouts in wall. */
export function borderTerrain(layout: Layout, environment: Environment): Terrain {
  if (environment === "outdoor") {
    if (layout === "open_field" || layout === "trail" || layout === "settlement") return T.OBSTACLE;
    if (layout === "islands") return T.LIQUID;
  }
  return T.WALL;
}

/** What replaces open tiles that turn out to be cut off from the party. */
export function pocketTerrain(layout: Layout, environment: Environment): Terrain {
  return borderTerrain(layout, environment);
}

export { Grid, T } from "./grid";
export type { LayoutFn, LayoutInput, LayoutOutput, RoomShape } from "./grid";
