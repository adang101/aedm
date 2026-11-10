import { CONTENT_RATINGS, type LobbyPlayer } from "@aedm/schemas";
import { isHost, type AppState } from "../state/store";
import { h, replaceChildren } from "../util/dom";
import { createCreator } from "./creator";
import type { Ctx, Screen } from "./types";

export function shareLink(code: string, mock: boolean): string {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("join", code);
  if (mock) u.searchParams.set("mock", "1");
  return u.toString();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0", value: text });
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

const STATUS_LABEL: Record<string, string> = { online: "online", away: "away", offline: "offline", autopilot: "autopilot" };

export function mountLobby(ctx: Ctx): Screen {
  const codeEl = h("div", { class: "invite-code", "aria-label": "Invite code" });
  const linkEl = h("input", { type: "text", readonly: true, class: "share-link", "aria-label": "Share link" });
  const copyCode = h("button", { type: "button", class: "btn small" }, "Copy code");
  const copyLink = h("button", { type: "button", class: "btn small" }, "Copy link");
  const leave = h("button", { type: "button", class: "btn ghost small", onClick: () => ctx.client.leave() }, "Leave");
  copyCode.addEventListener("click", async () => {
    const ok = await copyText(ctx.store.state.inviteCode ?? "");
    ctx.toast(ok ? "Invite code copied" : "Could not copy. Select and copy it manually.", ok ? "info" : "error");
  });
  copyLink.addEventListener("click", async () => {
    const ok = await copyText(linkEl.value);
    ctx.toast(ok ? "Link copied" : "Could not copy. Select and copy it manually.", ok ? "info" : "error");
  });

  const playerList = h("ul", { class: "players" });

  // settings
  const pitch = h("textarea", { rows: 3, maxlength: 300, id: "pitch", placeholder: "A pitch for the campaign, e.g. a drowned lighthouse and a sleepwalking village." });
  const rating = h("select", { id: "rating" }, ...CONTENT_RATINGS.map((r) => h("option", { value: r }, r)));
  const solo = h("input", { type: "checkbox", id: "dev-solo" });
  const hostNote = h("p", { class: "muted" });
  let pitchTimer: ReturnType<typeof setTimeout> | undefined;
  pitch.addEventListener("input", () => {
    clearTimeout(pitchTimer);
    pitchTimer = setTimeout(() => ctx.client.send("update_settings", { campaign_pitch: pitch.value.trim() }), 600);
  });
  pitch.addEventListener("blur", () => {
    clearTimeout(pitchTimer);
    if (!pitch.disabled && pitch.value.trim() !== (ctx.store.state.lobby?.settings.campaign_pitch ?? "")) ctx.client.send("update_settings", { campaign_pitch: pitch.value.trim() });
  });
  rating.addEventListener("change", () => ctx.client.send("update_settings", { content_rating: rating.value as "family" }));
  solo.addEventListener("change", () => ctx.client.send("update_settings", { dev_solo: solo.checked }));

  const readyBtn = h("button", { type: "button", class: "btn big" }, "Ready");
  readyBtn.addEventListener("click", () => {
    const s = ctx.store.state;
    const me = s.lobby?.players.find((p) => p.player_id === s.playerId);
    ctx.client.send("set_ready", { ready: !me?.ready });
  });
  const startBtn = h("button", { type: "button", class: "btn primary big" }, "Start game");
  startBtn.addEventListener("click", () => ctx.client.send("start_game", {}));
  const startHint = h("p", { class: "muted center" });

  // a room opened with "Resume" on a saved campaign: the host loads the save instead of starting fresh
  const resumeCard = h("section", { class: "card stack resume" });

  const claimedBox = h("section", { class: "card stack claimed" });
  const creator = createCreator(ctx, () => { editing = false; });
  const creatorCard = h("section", { class: "card" }, creator.el);
  let editing = false;

  const el = h("main", { class: "screen lobby" },
    h("header", { class: "card invite" },
      h("div", { class: "stack tight" }, h("span", { class: "label" }, "Invite code"), codeEl),
      h("div", { class: "stack tight grow" }, h("span", { class: "label" }, "Share link"), linkEl,
        h("div", { class: "row" }, copyCode, copyLink, leave)),
    ),
    h("div", { class: "lobby-grid" },
      h("div", { class: "stack" },
        h("section", { class: "card stack" }, h("h2", null, "Players"), playerList),
        resumeCard,
        h("section", { class: "card stack" },
          h("h2", null, "Campaign"),
          h("label", { for: "pitch" }, "Pitch"), pitch,
          h("div", { class: "row wrap" },
            h("label", { class: "inline", for: "rating" }, "Content rating", rating),
            h("label", { class: "inline check", for: "dev-solo" }, solo, "Dev solo mode")),
          hostNote),
        h("div", { class: "stack" }, readyBtn, startBtn, startHint),
      ),
      h("div", { class: "stack" }, claimedBox, creatorCard),
    ),
  );

  function playerRow(p: LobbyPlayer, s: AppState): HTMLElement {
    const isMe = p.player_id === s.playerId;
    const charLabel = p.character_id
      ? isMe && s.myCharacterName ? s.myCharacterName : "Character ready"
      : "No character yet";
    return h("li", { class: `player${isMe ? " me" : ""}` },
      h("span", { class: `dot ${p.status}`, title: STATUS_LABEL[p.status] ?? p.status }),
      h("span", { class: "pname" }, p.display_name, isMe ? " (you)" : ""),
      p.player_id === s.lobby?.host_player_id ? h("span", { class: "badge host" }, "host") : null,
      h("span", { class: "pchar muted" }, charLabel),
      h("span", { class: `badge ${p.ready ? "ready" : "waiting"}` }, p.ready ? "ready" : "not ready"),
    );
  }

  function update(s: AppState): void {
    const lobby = s.lobby;
    codeEl.textContent = s.inviteCode ?? "......";
    linkEl.value = s.inviteCode ? shareLink(s.inviteCode, s.mock) : "";
    if (!lobby) { replaceChildren(playerList, h("li", { class: "muted" }, "Joining the room...")); return; }

    replaceChildren(playerList, ...lobby.players.map((p) => playerRow(p, s)));
    const host = isHost(s);
    const me = lobby.players.find((p) => p.player_id === s.playerId);

    // settings are editable by the host only; avoid clobbering text being typed
    pitch.disabled = !host; rating.disabled = !host; solo.disabled = !host;
    if (document.activeElement !== pitch) pitch.value = lobby.settings.campaign_pitch;
    rating.value = lobby.settings.content_rating;
    solo.checked = lobby.settings.dev_solo;
    hostNote.textContent = host ? "You are the host. Only you can change these." : "Only the host can change these settings.";

    // resuming a saved campaign: characters come from the save
    const resume = lobby.resume_save;
    resumeCard.hidden = !resume;
    if (resume) {
      replaceChildren(resumeCard,
        h("h2", null, "Resuming a saved campaign"),
        h("p", { class: "muted" }, host
          ? `"${resume.name}" is ready. Wait for your friends to join with the invite code, then load it. Anyone who played before gets their character back.`
          : "Waiting for the host to load the saved campaign."),
        host ? h("button", { type: "button", class: "btn primary big", onClick: () => ctx.client.send("load_save", { save_id: resume.save_id }) }, "Load campaign") : null);
    }
    creator.update(s);

    // character area
    const hasChar = !!me?.character_id;
    creatorCard.hidden = (hasChar && !editing) || !!resume;
    replaceChildren(claimedBox,
      h("div", { class: "row between" },
        h("div", { class: "stack tight" }, h("span", { class: "label" }, "Your character"), h("b", { class: "big-name" }, s.myCharacterName ?? "Ready to play")),
        h("button", { type: "button", class: "btn small", onClick: () => { editing = true; update(ctx.store.state); creator.focusName(); } }, "Edit / replace")),
    );
    claimedBox.hidden = !hasChar || editing || !!resume;

    readyBtn.hidden = !!resume;
    readyBtn.textContent = me?.ready ? "Not ready" : "Ready";
    readyBtn.classList.toggle("primary", !me?.ready);
    readyBtn.disabled = !hasChar;
    const readyCount = lobby.players.filter((p) => p.ready).length;
    const canStart = readyCount >= 2 || lobby.settings.dev_solo;
    startBtn.hidden = !host || !!resume;
    startBtn.disabled = !canStart || !hasChar;
    startHint.hidden = !!resume;
    startHint.textContent = !hasChar ? "Create a character, then ready up."
      : host ? (canStart ? "Everyone ready? Start the adventure." : "Waiting for at least 2 ready players, or turn on dev solo mode.")
        : "Waiting for the host to start.";
  }

  return { el, update };
}
