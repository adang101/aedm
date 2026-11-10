import { validateRegistration, type CampaignInfo, type CharacterSummary } from "@aedm/schemas";
import { loadDisplayName, saveDisplayName } from "../state/storage";
import type { AppState } from "../state/store";
import { h, replaceChildren } from "../util/dom";
import { recipeIcon } from "./creator";
import type { Ctx, Screen } from "./types";

type Tab = "guest" | "login" | "register";

const TAB_LABEL: Record<Tab, string> = { guest: "Play as guest", login: "Log in", register: "Create account" };

function whenText(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  try {
    return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

export function mountHome(ctx: Ctx, prefillCode: string): Screen {
  const name = h("input", {
    type: "text", id: "display-name", maxlength: 24, autocomplete: "nickname", placeholder: "Your name at the table",
    value: loadDisplayName() || ctx.store.state.auth.user?.display_name || "",
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

  // ---------- account forms ----------
  let tab: Tab = "guest";
  const tabBtns = (["guest", "login", "register"] as const).map((t) => h("button", {
    type: "button", role: "tab", class: "tab", id: `tab-${t}`, "aria-controls": "auth-panel", onClick: () => { tab = t; authErr.textContent = ""; ctx.store.update((s) => { s.auth.error = null; }); renderTab(); },
  }, TAB_LABEL[t]));
  const authErr = h("p", { class: "field-error", role: "alert" });

  const loginUser = h("input", { type: "text", id: "login-username", name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: 20 });
  const loginPass = h("input", { type: "password", id: "login-password", name: "password", autocomplete: "current-password", maxlength: 128 });
  const loginBtn = h("button", { type: "submit", class: "btn primary big" }, "Log in");
  const loginForm = h("form", { class: "stack", novalidate: true },
    h("label", { for: "login-username" }, "Username", loginUser),
    h("label", { for: "login-password" }, "Password", loginPass),
    loginBtn);
  loginForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!loginUser.value.trim() || !loginPass.value) { authErr.textContent = "Enter your username and password."; return; }
    authErr.textContent = "";
    ctx.client.login(loginUser.value.trim(), loginPass.value);
  });

  const regUser = h("input", { type: "text", id: "reg-username", name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: 20 });
  const regDisplay = h("input", { type: "text", id: "reg-display", name: "display_name", autocomplete: "nickname", maxlength: 24, placeholder: "Shown to your table", value: loadDisplayName() });
  const regPass = h("input", { type: "password", id: "reg-password", name: "new-password", autocomplete: "new-password", maxlength: 128 });
  const regBtn = h("button", { type: "submit", class: "btn primary big" }, "Create account");
  const regForm = h("form", { class: "stack", novalidate: true },
    h("label", { for: "reg-username" }, "Username", regUser, h("small", { class: "muted" }, "3 to 20 characters: letters, digits, _ or -")),
    h("label", { for: "reg-display" }, "Display name", regDisplay),
    h("label", { for: "reg-password" }, "Password", regPass, h("small", { class: "muted" }, "8 to 128 characters")),
    regBtn);
  regForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = { username: regUser.value.trim(), password: regPass.value, display_name: regDisplay.value.trim() };
    const problem = validateRegistration(input);
    if (problem) { authErr.textContent = problem; return; }
    authErr.textContent = "";
    saveDisplayName(input.display_name);
    ctx.client.register(input.username, input.password, input.display_name);
  });

  const authPanel = h("div", { id: "auth-panel", role: "tabpanel", class: "stack" });
  const tabList = h("div", { class: "tabs", role: "tablist", "aria-label": "How to play" }, ...tabBtns);
  function renderTab(): void {
    tabBtns.forEach((b, i) => b.setAttribute("aria-selected", String((["guest", "login", "register"] as const)[i] === tab)));
    authPanel.setAttribute("aria-labelledby", `tab-${tab}`);
    replaceChildren(authPanel, tab === "guest" ? joinContent : tab === "login" ? loginForm : regForm, tab === "guest" ? null : authErr);
  }

  // ---------- signed-in panels ----------
  const whoLine = h("span", null);
  const logoutBtn = h("button", { type: "button", class: "btn small ghost", onClick: () => ctx.client.logout() }, "Log out");
  const accountBar = h("section", { class: "card account-bar row between wrap" },
    h("span", { class: "who" }, "Signed in as ", whoLine), logoutBtn);

  const charList = h("ul", { class: "saved-list" });
  const charCard = h("section", { class: "card stack" }, h("h2", null, "My characters"), charList,
    h("p", { class: "muted small-note" }, "Save a character from the creator in a lobby, then reuse it in any campaign."));

  const campList = h("ul", { class: "saved-list" });
  const campCard = h("section", { class: "card stack" }, h("h2", null, "My campaigns"), campList);

  const confirmDelete = new Set<string>();
  let charKey = "";
  function renderChars(list: CharacterSummary[]): void {
    const key = JSON.stringify([list.map((c) => [c.id, c.forged, c.ability_names]), [...confirmDelete]]);
    if (key === charKey) return;
    charKey = key;
    if (!list.length) { replaceChildren(charList, h("li", { class: "muted" }, "No saved characters yet.")); return; }
    replaceChildren(charList, ...list.map((c) => {
      const confirming = confirmDelete.has(c.id);
      return h("li", { class: "saved" },
        recipeIcon(c.sprite_recipe, c.name, 40),
        h("div", { class: "saved-main" },
          h("b", null, c.name), c.title ? h("span", { class: "muted" }, ` ${c.title}`) : null,
          h("small", { class: "muted" }, c.ability_names.join(", ") || "No abilities")),
        h("button", {
          type: "button", class: `btn tiny ${confirming ? "danger" : "ghost"}`, "aria-label": `Delete ${c.name}`,
          onClick: () => {
            if (confirming) { confirmDelete.delete(c.id); ctx.client.send("delete_character_template", { id: c.id }); }
            else { confirmDelete.add(c.id); charKey = ""; renderChars(ctx.store.state.auth.characters); }
          },
        }, confirming ? "Really delete?" : "Delete"));
    }));
  }

  let campKey = "";
  function renderCampaigns(list: CampaignInfo[] | null, busy: boolean): void {
    const key = JSON.stringify([list, busy]);
    if (key === campKey) return;
    campKey = key;
    if (list === null) { replaceChildren(campList, h("li", { class: "muted" }, "Loading...")); return; }
    if (!list.length) { replaceChildren(campList, h("li", { class: "muted" }, "No saved campaigns yet. Host a game while logged in, then save or just play.")); return; }
    replaceChildren(campList, ...list.map((c) => h("li", { class: "saved camp" },
      h("div", { class: "saved-main" },
        h("b", null, c.campaign_title || "Untitled campaign"),
        h("small", { class: "muted" }, `${c.kind === "autosave" ? "Latest autosave" : c.name} · ${whenText(c.updated_at)}`),
        h("small", { class: "muted" }, c.players.join(", "))),
      h("button", {
        type: "button", class: "btn small primary", disabled: busy || !c.can_resume,
        onClick: () => {
          const n = name.value.trim() || ctx.store.state.auth.user?.display_name || "Host";
          ctx.client.resumeCampaign({ save_id: c.save_id, room_id: c.room_id }, n.slice(0, 24));
        },
      }, "Resume"))));
  }

  const mockBadge = h("p", { class: "badge mock-badge" }, "Mock server: nothing leaves your browser");

  /** Name, host and join. Lives in the guest tab, or in its own card once signed in. */
  const joinContent = h("div", { class: "stack" },
    h("label", { for: "display-name" }, "Display name", name),
    h("div", { class: "split" },
      h("div", { class: "stack" }, h("h2", null, "Start a table"), h("p", { class: "muted" }, "You get an invite code to share."), hostBtn),
      h("div", { class: "stack" }, h("h2", null, "Join a friend"), code, joinBtn),
    ),
    err,
  );
  const joinCard = h("section", { class: "card stack" });

  const authCard = h("section", { class: "card stack auth-card" }, tabList, authPanel);

  const el = h("main", { class: "screen home" },
    h("div", { class: "hero" },
      h("div", { class: "logo", "aria-hidden": "true" }, "d20"),
      h("h1", null, "AI Dungeon Master"),
      h("p", { class: "tagline" }, "Gather two to six friends. An AI runs the table, the rules engine keeps it fair."),
    ),
    accountBar,
    authCard,
    joinCard,
    charCard,
    campCard,
    ctx.store.state.mock ? mockBadge : null,
  );
  renderTab();

  let requestedFor: string | null = null;
  let wasSignedIn = false;

  return {
    el,
    update(s: AppState) {
      const busy = s.busy;
      const user = s.auth.user;
      hostBtn.disabled = busy;
      joinBtn.disabled = busy;
      hostBtn.textContent = busy && s.inviteCode === null ? "Connecting..." : "Host a game";
      joinBtn.textContent = busy && s.inviteCode !== null ? "Joining..." : "Join";

      // guests see the tabs; signed-in users see their account instead (the name field then sits above the join card)
      authCard.hidden = !!user;
      accountBar.hidden = !user;
      charCard.hidden = !user;
      campCard.hidden = !user;
      joinCard.hidden = !user;
      if (user) {
        whoLine.textContent = `${user.display_name} (${user.username})`;
        if (!name.value.trim()) name.value = user.display_name;
      }
      if (!!user !== wasSignedIn) {
        wasSignedIn = !!user;
        if (user) joinCard.append(joinContent);
        else { tab = "guest"; renderTab(); }
      }

      const online = s.conn === "open";
      const authBusy = s.auth.pending || !online;
      loginBtn.disabled = authBusy;
      regBtn.disabled = authBusy;
      loginBtn.textContent = s.auth.pending ? "Working..." : online ? "Log in" : "Connecting...";
      regBtn.textContent = s.auth.pending ? "Working..." : online ? "Create account" : "Connecting...";
      if (s.auth.error && authErr.textContent !== s.auth.error) authErr.textContent = s.auth.error;
      if (!s.auth.error && s.auth.user) authErr.textContent = "";
      logoutBtn.disabled = !online;

      if (user) {
        renderChars(s.auth.characters);
        renderCampaigns(s.auth.campaigns, busy);
        if (online && requestedFor !== user.id) { requestedFor = user.id; ctx.client.refreshCampaigns(); }
      } else {
        requestedFor = null;
      }
    },
  };
}
