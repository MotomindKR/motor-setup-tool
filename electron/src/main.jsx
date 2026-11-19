import React from "react";
import { createRoot } from "react-dom/client";
import "@motomindkr/ui/styles.css";
import "../styles.css";
import { App } from "./App.jsx";
import { createController } from "./controller.mjs";

import { I18nextProvider } from "react-i18next";
import { i18n, t } from "../i18n.mjs";
import { applyLanguage } from "./language.mjs";

applyLanguage();
window.addEventListener("languagechange", () => applyLanguage());

if (window.motorApp) {
  document.documentElement.dataset.platform = window.motorApp.platform;
  const controller = createController(window.motorApp);
  createRoot(document.getElementById("root")).render(
    <I18nextProvider i18n={i18n}><App controller={controller} /></I18nextProvider>,
  );
} else {
  createRoot(document.getElementById("root")).render(
    <main className="browser-message">
      <h1>Motor Setup Tool</h1>
      <p>{t("Open the desktop app to connect a motor or view saved recordings.")}</p>
    </main>,
  );
}
