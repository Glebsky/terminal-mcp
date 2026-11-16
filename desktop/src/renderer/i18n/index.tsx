import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type MessageKey } from "./en";
import { uk } from "./uk";
import { ru } from "./ru";
import { toolTranslations } from "./tools";

export type { MessageKey } from "./en";
export type Language = "en" | "uk" | "ru";
export type TranslateParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

export const languages: ReadonlyArray<{ id: Language; label: string }> = [
  { id: "en", label: "English" },
  { id: "uk", label: "Українська" },
  { id: "ru", label: "Русский" },
];

const dictionaries: Record<Language, Record<MessageKey, string>> = { en, uk, ru };
const locales: Record<Language, string> = { en: "en-US", uk: "uk-UA", ru: "ru-RU" };
// Plural forms are separated by "|": en = one|other, uk/ru = one|few|many.
const pluralForms: Record<Language, Record<string, number>> = {
  en: { one: 0, other: 1 },
  uk: { one: 0, few: 1, many: 2, other: 2 },
  ru: { one: 0, few: 1, many: 2, other: 2 },
};
export const languageStorageKey = "mcp-terminal-language";

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "uk" || value === "ru";
}

export function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(languageStorageKey);
    if (isLanguage(stored)) return stored;
  } catch { /* Storage may be disabled by the OS. */ }
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const primary = (tag || "").toLowerCase().split("-")[0];
    if (isLanguage(primary)) return primary;
  }
  return "en";
}

export function formatMessage(lang: Language, template: string, params?: TranslateParams): string {
  let text = template;
  const count = params?.["count"];
  if (typeof count === "number" && text.includes("|")) {
    const forms = text.split("|");
    const rule = new Intl.PluralRules(locales[lang]).select(count);
    const index = pluralForms[lang][rule] ?? forms.length - 1;
    text = forms[Math.min(index, forms.length - 1)] ?? text;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

interface I18nValue {
  lang: Language;
  locale: string;
  setLang: (lang: Language) => void;
  t: Translate;
  /** Lookup for keys built at runtime (e.g. tool names); falls back to the given text. */
  tDynamic: (key: string, fallback: string, params?: TranslateParams) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>(detectLanguage);
  useEffect(() => {
    try { localStorage.setItem(languageStorageKey, lang); } catch { /* Storage may be disabled by the OS. */ }
    document.documentElement.lang = lang;
  }, [lang]);
  const t = useCallback<Translate>((key, params) => formatMessage(lang, dictionaries[lang][key] ?? en[key] ?? key, params), [lang]);
  const tDynamic = useCallback((key: string, fallback: string, params?: TranslateParams) => {
    const translated = lang === "en" ? undefined : toolTranslations[lang][key] ?? (dictionaries[lang] as Record<string, string>)[key];
    return formatMessage(lang, translated ?? fallback, params);
  }, [lang]);
  const value = useMemo<I18nValue>(() => ({ lang, locale: locales[lang], setLang, t, tDynamic }), [lang, t, tDynamic]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>.");
  return value;
}
