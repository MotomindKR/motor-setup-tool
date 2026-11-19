import React from "react";
import { createRoot } from "react-dom/client";
import "@motomindkr/ui/styles.css";
import "../styles.css";
import { App } from "./App.jsx";
import { createController } from "./controller.mjs";

if (window.motorApp) {
  document.documentElement.dataset.platform = window.motorApp.platform;
  const controller = createController(window.motorApp);
  createRoot(document.getElementById("root")).render(
    <App controller={controller} />,
  );
} else {
  createRoot(document.getElementById("root")).render(
    <main className="browser-message">
      <h1>Motor Setup Tool</h1>
      <p>Open the desktop app to connect a motor or view saved recordings.</p>
    </main>,
  );
}
