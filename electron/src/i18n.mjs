import { createInstance } from "i18next";
import options from "../locales/options.json" with { type: "json" };
import korean from "../locales/ko.json" with { type: "json" };

export const i18n = createInstance();
i18n.init({ ...options, resources: { ko: { translation: korean } } });

export const t = i18n.t.bind(i18n);

// Keep message parameters until render so existing notices follow the language setting.
export const message = (key, values) => ({ key, values });

export function messageText(value) {
  if (!value) return "";
  if (typeof value === "string") return i18n.exists(value) ? t(value) : value;
  return t(value.key, value.values);
}
