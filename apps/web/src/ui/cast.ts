import { CUSTOM_CAST_MODES, type CastEntry, type CustomCast } from "@aedm/schemas";
import { isHost, type AppState } from "../state/store";
import { ROLE_LABEL, hidePrefs, offerable, setEntryHidden, setHidePaintings } from "../state/workshop";
import { h, replaceChildren } from "../util/dom";
import { recipeIcon } from "./creator";
import type { Ctx, Screen } from "./types";
import { openWorkshop } from "./workshop";

const CAST_LABEL: Record<CustomCast, string> = { off: "Off", host_approval: "Host approves each one", open: "Open to everyone" };

/** The campaign cast: sprites players offer to the DM, the host's approval, and each viewer's own hide switches. */
export function createCastPanel(ctx: Ctx): Screen {
  const castSel = h("select", { id: "custom-cast" }, ...CUSTOM_CAST_MODES.map((m) => h("option", { value: m }, CAST_LABEL[m])));
  const paintChk = h("input", { type: "checkbox", id: "custom-paintings" });
  const hostNote = h("p", { class: "muted" });
  castSel.addEventListener("change", () => ctx.client.send("update_settings", { custom_cast: castSel.value as CustomCast }));
  paintChk.addEventListener("change", () => ctx.client.send("update_settings", { custom_paintings: paintChk.checked }));

  const hideAll = h("input", { type: "checkbox", id: "hide-paintings" });
  hideAll.checked = hidePrefs().paintings;
  hideAll.addEventListener("change", () => { setHidePaintings(hideAll.checked); ctx.store.update(() => undefined); });

  const entries = h("ul", { class: "saved-list", "aria-label": "Cast" });
  const offerBox = h("div", { class: "stack tight" });
  let key = "";
  let asked = false;

  const decide = (e: CastEntry, approve: boolean) => ctx.client.send("cast_decision", { asset_id: e.asset_id, approve });

  function entryRow(e: CastEntry, s: AppState, host: boolean): HTMLElement {
    const mine = e.owner_player_id === s.playerId;
    const hidden = hidePrefs().ids.has(e.asset_id);
    return h("li", { class: `saved cast-item${hidden ? " hidden-by-me" : ""}`, "data-asset": e.asset_id },
      recipeIcon(hidden ? { kind: "shape", shape: "circle", color: "#6b6b7b", accent: "#9a9aab", glyph: "?" } : e.recipe, e.name, 40),
      h("div", { class: "saved-main" },
        h("div", { class: "row wrap" }, h("b", null, e.name), h("span", { class: "badge" }, ROLE_LABEL[e.role_hint]),
          h("span", { class: `badge ${e.status}` }, e.status === "pending" ? "waiting for the host" : "in the cast")),
        h("small", { class: "muted" }, `from ${e.owner_name}${e.concept ? `: ${e.concept}` : ""}`),
        h("div", { class: "cast-actions" },
          host && e.status === "pending" ? h("button", { type: "button", class: "btn tiny primary", onClick: () => decide(e, true) }, "Approve") : null,
          host && e.status === "pending" ? h("button", { type: "button", class: "btn tiny", onClick: () => decide(e, false) }, "Deny") : null,
          host && e.status === "approved" ? h("button", { type: "button", class: "btn tiny", onClick: () => decide(e, false) }, "Remove") : null,
          !host && mine ? h("button", { type: "button", class: "btn tiny", onClick: () => decide(e, false) }, "Withdraw") : null,
          h("button", {
            type: "button", class: "btn tiny ghost", "aria-pressed": String(hidden),
            title: "Hide this look for you only",
            onClick: () => { setEntryHidden(e.asset_id, !hidden); ctx.store.update(() => undefined); },
          }, hidden ? "Show" : "Hide"))));
  }

  const el = h("section", { class: "card stack cast-panel", "aria-label": "Campaign cast" },
    h("h2", null, "Campaign cast"),
    h("p", { class: "muted" }, "Looks players made for NPCs and enemies. The DM may use approved ones; stats still come from the rules engine."),
    h("div", { class: "row wrap" },
      h("label", { class: "inline", for: "custom-cast" }, "Custom sprites", castSel),
      h("label", { class: "inline check", for: "custom-paintings" }, paintChk, "Allow painted sprites")),
    hostNote, entries, offerBox,
    h("label", { class: "inline check", for: "hide-paintings" }, hideAll, "Hide all painted sprites (only for me)"));

  function update(s: AppState): void {
    const lobby = s.lobby;
    if (!lobby) return;
    const host = isHost(s);
    const mode = lobby.settings.custom_cast ?? "host_approval";
    const paintings = lobby.settings.custom_paintings !== false;
    castSel.disabled = !host; paintChk.disabled = !host;
    castSel.value = mode; paintChk.checked = paintings;
    hostNote.textContent = host ? "You are the host. You choose what joins the cast." : "Only the host changes these settings.";
    hideAll.checked = hidePrefs().paintings;

    const user = s.auth.user;
    const w = s.auth.workshop;
    if (!user) asked = false;
    else if (!w && !asked && s.conn === "open") { asked = true; ctx.client.refreshWorkshop(); }
    const offers = user && w ? offerable(w.assets, s.cast) : [];
    const k = JSON.stringify([
      s.cast.map((c) => [c.asset_id, c.status, c.name, c.owner_name]), [...hidePrefs().ids], host, s.playerId, mode, paintings,
      !!user, offers.map((a) => a.id), w === null,
    ]);
    if (k === key) return;
    key = k;

    replaceChildren(entries, ...(s.cast.length
      ? s.cast.map((e) => entryRow(e, s, host))
      : [h("li", { class: "muted" }, "Nobody has offered a sprite yet.")]));

    const off = mode === "off";
    replaceChildren(offerBox,
      h("h3", null, "Offer a sprite"),
      !user
        ? h("p", { class: "muted" }, "Log in to offer looks from your Workshop. Guests can still see the cast.")
        : off
          ? h("p", { class: "muted" }, "The host has turned custom sprites off.")
          : h("div", { class: "stack tight" },
            ...(offers.length
              ? offers.map((a) => h("div", { class: "cast-offer", "data-asset": a.id },
                recipeIcon(a.recipe, a.name, 32), h("span", { class: "grow" }, `${a.name} (${ROLE_LABEL[a.role_hint]})`),
                h("button", {
                  type: "button", class: "btn tiny primary",
                  disabled: a.recipe.kind === "pixel" && !paintings, title: a.recipe.kind === "pixel" && !paintings ? "The host turned painted sprites off" : "",
                  onClick: () => ctx.client.send("offer_to_cast", { asset_id: a.id }),
                }, "Offer")))
              : [h("p", { class: "muted" }, w ? "No NPC or enemy looks left to offer. Make one in your Workshop." : "Loading your Workshop...")])),
      user ? h("div", { class: "row" }, h("button", { type: "button", class: "btn small", onClick: () => openWorkshop(ctx) }, "Open my Workshop")) : null);
  }

  return { el, update };
}
