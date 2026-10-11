// Entry point. The game boots by default; ?gallery shows every model on a lawn (a dev page).
import { startGallery } from "./gallery";
import { startGame } from "./game";

const root = document.getElementById("app");
if (!root) throw new Error("no #app");
if (new URLSearchParams(location.search).has("gallery")) startGallery(root);
else startGame(root);
