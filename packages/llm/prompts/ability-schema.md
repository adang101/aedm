ABILITY JSON (exact field names):
- "name": string, at most 40 characters.
- "description": string, at most 200 characters.
- "tags": array of 0 to 2 check tags.
- "action": "action" or "quick".
- "target": "self", "ally", "enemy", "any" or "tile".
- "range_tiles": integer 0 to 12.
- "effects": array of 1 to 4 effects (below).
- Exactly one of "cooldown_turns" (integer 0 to 6) or "uses_per_rest" (integer 1 to 3).
- "forge_notes": optional string, at most 200 characters.
- "v": 1 (optional). Never include "cost" or "id".

EFFECTS (every effect may also carry "affects": "enemies", "allies" or "all"):
- damage: {"type":"damage","shape":"single|burst|line|cone","radius_tiles":1-2 (burst only),"length_tiles":1-6 for line / 1-4 for cone,"dice":"NdM" (N 1-8, M one of 4,6,8,10,12),"damage_type":one of [{{damage_types}}],"save":{"ability":"str|dex|con|int|wis|cha","dc":"caster_dc"} (optional),"on_save":"half|none" (required if and only if save is present)}
- heal: {"type":"heal","shape":"single|burst","radius_tiles":1-2 (burst only),"dice":"NdM"}
- shield: {"type":"shield","absorb":1-40,"duration_turns":1-3}
- condition: {"type":"condition","condition":one of [{{conditions}}],"duration_turns":1-3,"on":"hit|failed_save|always","save":{"ability":...,"dc":"caster_dc"} (optional)}
- push / pull: {"type":"push","tiles":1-4}
- dash: {"type":"dash","tiles":1-8,"with_attack":true|false}
- teleport: {"type":"teleport","tiles":1-6}
- mark: {"type":"mark","duration_turns":1-3}
- reveal: {"type":"reveal","radius_tiles":1-2}
- disarm: {"type":"disarm"}
- terrain: {"type":"terrain","kind":one of [{{terrain_kinds}}],"shape":"tile|burst|line","radius_tiles":1-2 (burst),"length_tiles":1-6 (line),"duration_turns":1-3,"dice":"NdM" and "damage_type" (both or neither; only for kind fire or trap)}
- check_bonus: {"type":"check_bonus","bonus":1-4,"tags":[1 to 2 check tags],"duration_turns":1-3}
Shape rules: burst needs radius_tiles and no length_tiles; line and cone need length_tiles and no radius_tiles; single takes neither.
