import "./styles.css";
import { GameClient } from "./net/client";
import { MockServer } from "./net/mock";
import { MOCK_TILESET } from "./net/mock-world";
import { webSocketFactory, type TransportFactory } from "./net/transport";
import tilesetBlocks from "@aedm/engine/data/tileset-blocks.json";
import { setTileset, type TilesetDesc } from "./render/tileset";
import { Store, type AppState } from "./state/store";
import { h, replaceChildren } from "./util/dom";
import { mountGame } from "./ui/game";
import { mountHome } from "./ui/home";
import { mountLobby } from "./ui/lobby";
import { toast } from "./ui/toast";
import type { Ctx, Screen } from "./ui/types";

type Route = "home" | "lobby" | "game";

const params = new URLSearchParams(location.search);
const mock = params.get("mock") === "1";

const store = new Store();
store.state.mock = mock;

let factory: TransportFactory;
if (mock) {
  const server = new MockServer();
  setTileset(MOCK_TILESET); // real mode: call setTileset(...) with the server's tileset JSON (see render/tileset.ts)
  (window as unknown as { __mock: MockServer }).__mock = server; // dev hook: __mock.simulateDisconnect()
  factory = server.factory;
} else {
  setTileset(tilesetBlocks as unknown as TilesetDesc);
  factory = webSocketFactory();
}

const client = new GameClient(store, factory, { notify: (m, k) => toast(m, k ?? "error") });
const ctx: Ctx = { store, client, toast };

function routeOf(s: AppState): Route {
  if (!s.playerId) return "home";
  return s.lobby?.phase === "playing" ? "game" : "lobby";
}

const CONN_LABEL: Record<AppState["conn"], string> = {
  idle: "Offline", connecting: "Connecting", open: "Connected", reconnecting: "Reconnecting", closed: "Disconnected",
};

const connDot = h("span", { class: "conn-dot" });
const connText = h("span", null);
const conn = h("span", { class: "conn", role: "status" }, connDot, connText);
const roomPill = h("span", { class: "room-pill", hidden: true });
const leaveBtn = h("button", { type: "button", class: "btn tiny ghost", hidden: true, onClick: () => client.leave() }, "Leave");
const saveBtn = h("button", {
  type: "button", class: "btn tiny ghost", hidden: true, title: "Write a named save of this campaign",
  onClick: () => {
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    client.send("request_save", { name: `Save ${t}` });
  },
}, "Save");
const header = h("header", { class: "topbar" }, h("span", { class: "brand" }, h("b", null, "AEDM"), h("span", { class: "muted" }, " AI Dungeon Master")), h("span", { class: "grow" }), roomPill, conn, saveBtn, leaveBtn);

const reloadModal = h("div", { class: "modal", hidden: true },
  h("div", { class: "modal-card stack", role: "alertdialog", "aria-modal": "true" },
    h("h2", null, "Please reload"),
    h("p", null, "The game was updated and this page is out of date. Reload to keep playing."),
    h("button", { type: "button", class: "btn primary big", onClick: () => location.reload() }, "Reload")));

const content = h("div", { class: "content" });
document.getElementById("app")?.append(header, content, reloadModal);

let route: Route | null = null;
let screen: Screen | null = null;

function mount(r: Route): Screen {
  switch (r) {
    case "home": return mountHome(ctx, params.get("join") ?? "");
    case "lobby": return mountLobby(ctx);
    case "game": return mountGame(ctx);
  }
}

function render(s: AppState): void {
  const r = routeOf(s);
  if (r !== route) {
    screen?.destroy?.();
    screen = mount(r);
    route = r;
    replaceChildren(content, screen.el);
    document.body.dataset.route = r;
    window.scrollTo(0, 0);
  }
  screen?.update(s);

  const label = s.mock && s.conn === "open" ? "Mock server" : CONN_LABEL[s.conn];
  connText.textContent = label;
  conn.className = `conn ${s.conn}`;
  conn.hidden = s.conn === "idle";
  roomPill.hidden = !s.inviteCode || r === "home";
  roomPill.textContent = s.inviteCode ?? "";
  leaveBtn.hidden = r === "home";
  saveBtn.hidden = r !== "game";
  reloadModal.hidden = !s.versionMismatch;
}

store.subscribe(render);
render(store.state);
client.connect(); // the home screen needs a connection for log in, register and the account lists
