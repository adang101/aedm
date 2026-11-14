import { spriteSwatch, type EntityView } from "@aedm/schemas";
import { MapRenderer, type TapInfo } from "../render/renderer";
import { myCharacter, myEntity, pendingLevelUp, type AppState } from "../state/store";
import { targetsOnMap, targetTitle } from "../util/interact";
import { h, replaceChildren } from "../util/dom";
import { createHud, type Pending } from "./hud";
import { createContainerPanel } from "./container";
import { nearbyMenu, targetMenu } from "./interact-menu";
import { createLevelUpModal } from "./levelup";
import { createLog } from "./log";
import { closeMenu, openMenu, type MenuItem } from "./menu";
import { createSheetModal } from "./sheet";
import type { Ctx, Screen } from "./types";
import { createVoteModal } from "./vote";

type Tab = "story" | "quests";
const DIRS: Record<string, "n" | "s" | "e" | "w"> = {
  w: "n", arrowup: "n", s: "s", arrowdown: "s", a: "w", arrowleft: "w", d: "e", arrowright: "e",
};

export function mountGame(ctx: Ctx): Screen {
  const { client, store } = ctx;
  let pending: Pending = null;
  let tab: Tab = "story";
  let channel: "ic" | "ooc" = "ic";
  const levelUpModal = createLevelUpModal(ctx);

  // ---------- canvas ----------
  const canvas = h("canvas", { class: "map-canvas", tabindex: 0, "aria-label": "Game map. Press E to use things next to you." });
  const loading = h("div", { class: "loading" }, "Loading the world...");
  const zoomIn = h("button", { type: "button", class: "btn tiny", "aria-label": "Zoom in" }, "+");
  const zoomOut = h("button", { type: "button", class: "btn tiny", "aria-label": "Zoom out" }, "-");

  const hud = createHud({
    onAttack() { pending = pending?.kind === "attack" ? null : { kind: "attack" }; refresh(); },
    onAbility(a, id) {
      if (a.target === "self") { client.send("use_ability", { ability_id: id, target: myEntity(store.state)?.id ?? "" }); return; }
      pending = pending?.kind === "ability" && pending.id === id ? null : { kind: "ability", ability: a, id };
      refresh();
    },
    onEndTurn() { client.send("end_turn", {}); pending = null; refresh(); },
    onCancel() { pending = null; refresh(); },
    onLevelUp() { levelUpModal.open(); },
  });

  const mapWrap = h("div", { class: "map-wrap" }, canvas, hud.top, hud.bottom, hud.levelUp, h("div", { class: "zoom" }, zoomIn, zoomOut), loading);

  const renderer = new MapRenderer(canvas, store, {
    onTap: (info) => handleTap(info),
    isTargetable: (e) => isValidTarget(e),
  });
  zoomIn.addEventListener("click", () => renderer.zoomBy(1.2));
  zoomOut.addEventListener("click", () => renderer.zoomBy(1 / 1.2));
  renderer.start();

  function isValidTarget(e: EntityView): boolean {
    if (!pending) return false;
    if (pending.kind === "attack") return e.kind === "enemy";
    const t = pending.ability.target;
    if (t === "enemy") return e.kind === "enemy";
    if (t === "ally") return e.kind === "pc";
    return t === "any";
  }

  // ---------- interaction ----------
  function abilityMenu(target: EntityView | null, tile: { x: number; y: number }): MenuItem[] {
    const ch = myCharacter(store.state);
    return (ch?.abilities ?? []).map((a, i) => {
      const id = a.id ?? `ab_${i}`;
      return {
        label: a.name, hint: `${a.action}, range ${a.range_tiles}`,
        run: () => client.send("use_ability", { ability_id: id, target: a.target === "tile" || !target ? tile : target.id }),
      };
    });
  }

  function handleTap(info: TapInfo): void {
    closeMenu();
    const s = store.state;
    const target = info.entityId ? (s.entities[info.entityId] ?? null) : null;
    if (pending) {
      const p = pending;
      if (p.kind === "attack") {
        if (target?.kind === "enemy") { client.send("basic_attack", { target_id: target.id }); pending = null; refresh(); }
        else ctx.toast("Pick an enemy to attack.");
      } else {
        const t = p.ability.target;
        if (t === "tile") client.send("use_ability", { ability_id: p.id, target: { x: info.tileX, y: info.tileY } });
        else if (target && isValidTarget(target)) client.send("use_ability", { ability_id: p.id, target: target.id });
        else { ctx.toast(`${p.ability.name} needs a ${t === "any" ? "target" : t}.`); return; }
        pending = null; refresh();
      }
      return;
    }
    const tile = { x: info.tileX, y: info.tileY };
    if (target) {
      const mine = myEntity(s)?.id === target.id;
      const items: MenuItem[] = [{ label: "Examine", run: () => client.send("act", { verb: "examine", target_id: target.id }) }];
      if (target.kind === "npc") items.push({ label: "Talk", run: () => client.send("act", { verb: "talk", target_id: target.id }) });
      if (target.kind === "enemy") items.push({ label: "Attack", run: () => client.send("basic_attack", { target_id: target.id }) });
      const abil = abilityMenu(target, tile);
      if (abil.length) items.push({ label: "Use ability", children: abil });
      openMenu(`${target.name}${mine ? " (you)" : ""}`, items, info.clientX, info.clientY);
      return;
    }
    const here = targetsOnMap(s.map, s.containers, []).find((t) =>
      (info.interactable ? t.type === "interactable" && t.id === info.interactable.id : t.type === "container" && t.id === info.containerId));
    if (here) {
      const items = targetMenu(ctx, here);
      items.push({ label: "Move here", run: () => { client.send("move_intent", tile); renderer.flashTile(tile.x, tile.y); } });
      openMenu(targetTitle(here, s.entities), items, info.clientX, info.clientY);
      return;
    }
    client.send("move_intent", tile);
    renderer.flashTile(tile.x, tile.y);
  }

  let lastKey = 0;
  const onKey = (ev: KeyboardEvent): void => {
    const t = ev.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (ev.key === "Escape") { closeMenu(); if (pending) { pending = null; refresh(); } return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key.toLowerCase() === "e") {
      ev.preventDefault();
      const items = nearbyMenu(ctx);
      if (items.length === 0) { ctx.toast("Nothing within reach.", "info"); return; }
      const r = canvas.getBoundingClientRect();
      openMenu("Nearby", items, r.left + r.width / 2 - 90, r.top + r.height / 2);
      return;
    }
    const dir = DIRS[ev.key.toLowerCase()];
    if (!dir) return;
    ev.preventDefault();
    const now = performance.now();
    if (now - lastKey < 100) return; // stay under the 10 moves/second limit
    lastKey = now;
    client.send("move_intent", { direction: dir });
  };
  document.addEventListener("keydown", onKey);

  // ---------- side panel ----------
  const log = createLog();
  const chipRow = h("div", { class: "chips" });
  const input = h("input", { type: "text", maxlength: 500, placeholder: "What do you do or say?", "aria-label": "Message", autocomplete: "off", enterkeyhint: "send" });
  const modeBtn = h("button", { type: "button", class: "btn small mode ic", title: "In character goes to the DM. Out of character is only chat." }, "IC");
  const sendBtn = h("button", { type: "submit", class: "btn primary small" }, "Send");
  modeBtn.addEventListener("click", () => {
    channel = channel === "ic" ? "ooc" : "ic";
    modeBtn.textContent = channel.toUpperCase();
    modeBtn.className = `btn small mode ${channel}`;
    input.placeholder = channel === "ic" ? "What do you do or say?" : "Out-of-character chat (the DM does not see it)";
  });
  const form = h("form", { class: "composer", autocomplete: "off" }, modeBtn, input, sendBtn);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (client.send("say", { text, channel })) input.value = "";
  });

  const partyBar = h("div", { class: "party" });
  const questList = h("div", { class: "quests stack" });
  const storyPane = h("div", { class: "pane story" }, log.el, chipRow, form);
  const questPane = h("div", { class: "pane quest-pane", hidden: true }, questList);
  const tabBtns = (["story", "quests"] as const).map((t) => h("button", {
    type: "button", class: "tab", role: "tab", "data-tab": t,
    onClick: () => { tab = t; refresh(); },
  }, t === "story" ? "Story" : "Quests"));
  const panel = h("aside", { class: "panel" }, partyBar, h("div", { class: "tabs", role: "tablist" }, ...tabBtns), storyPane, questPane);

  const vote = createVoteModal(ctx);
  const sheet = createSheetModal(ctx);
  const loot = createContainerPanel(ctx);
  const el = h("main", { class: "screen game" }, mapWrap, panel, loot.el, vote.el, levelUpModal.el, sheet.el);

  // ---------- update ----------
  function refresh(): void { update(store.state); }

  function updateParty(s: AppState): void {
    const activeId = s.combat?.active_id;
    replaceChildren(partyBar, ...s.party.map((c) => {
      const e = s.entities[c.id];
      const hp = e?.hp ?? c.hp, max = e?.hp_max ?? c.hp_max;
      const owner = e?.owner_player_id ?? s.claimed[c.id];
      const player = s.lobby?.players.find((p) => p.player_id === owner);
      const frac = Math.max(0, Math.min(1, hp / max));
      const mine = owner === s.playerId;
      const lu = mine ? pendingLevelUp(s) : null;
      const open = () => sheet.open(c.id);
      const card = h("div", {
        class: `member clickable${activeId === c.id ? " active" : ""}${mine ? " me" : ""}`, title: `${c.name}: ${c.title} (open character sheet)`,
        role: "button", tabindex: 0, "aria-label": `${c.name}, level ${c.level}. Open character sheet`,
        onClick: open,
        onKeydown: (ev: Event) => { const k = (ev as KeyboardEvent).key; if (k === "Enter" || k === " ") { ev.preventDefault(); open(); } },
      },
        h("span", { class: "init-dot", style: `background:${spriteSwatch(c.sprite_recipe, c.name).color};border-color:${spriteSwatch(c.sprite_recipe, c.name).accent}` }, spriteSwatch(c.sprite_recipe, c.name).glyph),
        h("div", { class: "member-main" },
          h("div", { class: "member-name" }, h("span", { class: `dot ${player?.status ?? "online"}` }), c.name.split(" ")[0]),
          h("div", { class: "hpbar" }, h("i", { class: frac < 0.3 ? "low" : frac < 0.6 ? "mid" : "", style: `width:${Math.round(frac * 100)}%` })),
          h("div", { class: "hptext" }, `${hp}/${max} - Lv ${c.level}`)),
        lu ? h("button", {
          type: "button", class: "lvl-badge", "aria-label": "Level up",
          onClick: (ev: Event) => { ev.stopPropagation(); levelUpModal.open(); },
        }, "Level up!") : null,
        (e?.conditions.length ?? 0) > 0 ? h("div", { class: "conds" }, ...e!.conditions.map((c2) => h("span", { class: "cond" }, c2.condition))) : null);
      return card;
    }));
  }

  function updateQuests(s: AppState): void {
    if (s.quests.length === 0) { replaceChildren(questList, h("p", { class: "muted" }, "No quests yet.")); return; }
    replaceChildren(questList, ...s.quests.map((q) => h("div", { class: `quest ${q.status}` },
      h("div", { class: "row between" }, h("b", null, q.title), h("span", { class: `badge q-${q.status}` }, q.status)),
      ...(q.notes.length ? [h("ul", null, ...q.notes.map((n) => h("li", null, n)))] : []))));
  }

  function update(s: AppState): void {
    loading.hidden = !!s.map;
    if (pending && !s.combat) pending = null;
    hud.update(s, pending);
    canvas.classList.toggle("targeting", pending !== null);
    updateParty(s);
    updateQuests(s);
    log.update(s);
    vote.update(s);
    levelUpModal.update(s);
    sheet.update(s);
    loot.update(s);
    replaceChildren(chipRow, ...s.chips.map((c) => h("button", {
      type: "button", class: "chip", onClick: () => { client.send("say", { text: c, channel: "ic" }); },
    }, c)));
    chipRow.hidden = s.chips.length === 0;
    for (const b of tabBtns) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    storyPane.hidden = tab !== "story";
    questPane.hidden = tab !== "quests";
    const active = s.quests.filter((q) => q.status === "active" || q.status === "new").length;
    tabBtns[1]!.textContent = active ? `Quests (${active})` : "Quests";
  }

  const ticker = setInterval(() => { hud.tick(store.state); vote.tick(); }, 250);

  return {
    el,
    update,
    destroy() {
      clearInterval(ticker);
      document.removeEventListener("keydown", onKey);
      renderer.stop();
      closeMenu();
    },
  };
}

