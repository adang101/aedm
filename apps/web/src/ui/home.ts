import { loadDisplayName, saveDisplayName } from "../state/storage";
import type { AppState } from "../state/store";
import { h } from "../util/dom";
import type { Ctx, Screen } from "./types";

export function mountHome(ctx: Ctx, prefillCode: string): Screen {
  const name = h("input", {
    type: "text", id: "display-name", maxlength: 24, autocomplete: "nickname", placeholder: "Your name at the table",
    value: loadDisplayName(),
  });
  const code = h("input", {
    type: "text", id: "invite-code", maxlength: 16, autocapitalize: "characters", autocomplete: "off", spellcheck: "false",
    placeholder: "INVITE CODE", value: prefillCode.toUpperCase(),
  });
  const err = h("p", { class: "field-error", role: "alert" });
  const hostBtn = h("button", { class: "btn primary big", type: "button" }, "Host a game");
  const joinBtn = h("button", { class: "btn big", type: "button" }, "Join");

  const validName = (): string | null => {
    const n = name.value.trim();
    if (n.length < 1 || n.length > 24) { err.textContent = "Enter a display name (1 to 24 characters)."; name.focus(); return null; }
    err.textContent = "";
    saveDisplayName(n);
    return n;
  };
  hostBtn.addEventListener("click", () => {
    const n = validName();
    if (n) ctx.client.host(n);
  });
  const doJoin = () => {
    const n = validName();
    if (!n) return;
    const c = code.value.trim();
    if (!c) { err.textContent = "Enter the invite code from your host."; code.focus(); return; }
    ctx.client.join(c, n);
  };
  joinBtn.addEventListener("click", doJoin);
  code.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") (code.value ? doJoin : () => hostBtn.click())(); });
  code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""); });

  const mockBadge = h("p", { class: "badge mock-badge" }, "Mock server: nothing leaves your browser");

  const el = h("main", { class: "screen home" },
    h("div", { class: "hero" },
      h("div", { class: "logo", "aria-hidden": "true" }, "d20"),
      h("h1", null, "AI Dungeon Master"),
      h("p", { class: "tagline" }, "Gather two to six friends. An AI runs the table, the rules engine keeps it fair."),
    ),
    h("section", { class: "card stack" },
      h("label", { for: "display-name" }, "Display name"), name,
      h("div", { class: "split" },
        h("div", { class: "stack" }, h("h2", null, "Start a table"), h("p", { class: "muted" }, "You get an invite code to share."), hostBtn),
        h("div", { class: "stack" }, h("h2", null, "Join a friend"), code, joinBtn),
      ),
      err,
    ),
    ctx.store.state.mock ? mockBadge : null,
  );

  return {
    el,
    update(s: AppState) {
      const busy = s.busy;
      hostBtn.disabled = busy;
      joinBtn.disabled = busy;
      hostBtn.textContent = busy && s.inviteCode === null ? "Connecting..." : "Host a game";
      joinBtn.textContent = busy && s.inviteCode !== null ? "Joining..." : "Join";
    },
  };
}
