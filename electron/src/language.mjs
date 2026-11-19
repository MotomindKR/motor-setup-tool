import { i18n } from "./i18n.mjs";

export let formatLocale;

const preferenceKey = "motomind-language";
export function languageChoice() {
  const choice = localStorage.getItem(preferenceKey);
  return choice === "en" || choice === "ko" ? choice : "system";
}

export function applyLanguage(choice = languageChoice()) {
  const preferred = choice === "system" ? navigator.languages : [choice];
  const language =
    preferred
      .map((tag) => tag.split("-")[0].toLowerCase())
      .find((tag) => tag === "ko" || tag === "en") || "en";
  formatLocale = choice === "system" ? navigator.language : language;
  i18n.changeLanguage(language);
  document.documentElement.lang = language;
  window.motorApp?.setLanguage(language);
}

export function chooseLanguage(choice) {
  localStorage.setItem(preferenceKey, choice);
  applyLanguage(choice);
}
