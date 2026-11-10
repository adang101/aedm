import "./styles.css";

/** Entry point: the game, or (with ?mock=1&gallery=1) the renderer gallery for visual QA. */
const params = new URLSearchParams(location.search);

if (params.get("mock") === "1" && params.get("gallery") === "1") {
  void import("./render/gallery").then((g) => g.mountGallery(document.getElementById("app")!));
} else {
  void import("./app");
}
