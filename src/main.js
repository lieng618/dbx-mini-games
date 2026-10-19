// The DBX sandbox forbids eval, and PixiJS probes for it while choosing a shader path.
// This official polyfill installs non-eval implementations before the renderer boots.
import "pixi.js/unsafe-eval";
import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");
