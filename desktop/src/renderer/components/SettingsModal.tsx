import { useEffect, useId, useState, type FormEvent } from "react";
import { AlertCircle, Check, Eye, EyeOff, Folder, KeyRound, LoaderCircle, Palette, RefreshCw, Save, Server, Settings2, Shield } from "lucide-react";
import type { EnvConfig } from "../../types";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "../lib/shadcn/ui";
import { isLanguage, languages, useI18n } from "../i18n";
import { SettingsField } from "./SettingsField";
import { TunnelSettings } from "./TunnelSettings";
import { ToolSettings } from "./ToolSettings";
import "../styles/settings.css";
interface SettingsModalProps {
  isOpen: boolean; onClose: () => void; onSaved: () => void;
  animation: boolean; onAnimationChange: (enabled: boolean) => void;
  backgroundAnimation: boolean; onBackgroundAnimationChange: (enabled: boolean) => void;
  reducedMotion: boolean;
}
export function SettingsModal({ isOpen, onClose, onSaved, animation, onAnimationChange, backgroundAnimation, onBackgroundAnimationChange, reducedMotion }: SettingsModalProps) {
  const { t, lang, setLang } = useI18n();
  const [config, setConfig] = useState<EnvConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [error, setError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const keyId = useId(); const rootId = useId();
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true); setError(""); setSavedSuccess(false); setConfig(null); setShowKey(false);
    void window.electronAPI.getConfig().then(value => { if (!cancelled) setConfig(value); }).catch(() => { if (!cancelled) setError(t("settings.loadError")); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateConfig = (value: EnvConfig) => { setConfig(value); setSavedSuccess(false); setError(""); };
  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!config || saving) return;
    setSaving(true); setError(""); setSavedSuccess(false);
    try {
      const result = await window.electronAPI.saveConfig(config);
      if (result.success) { setSavedSuccess(true); onSaved(); }
      else setError(result.error || t("settings.saveError"));
    } catch { setError(t("settings.savePermissionsError")); }
    finally { setSaving(false); }
  };
  const selectFolder = async () => {
    try { const selected = await window.electronAPI.selectFolder(); if (selected) setConfig(current => current ? { ...current, FILES_ROOT: selected } : current); setSavedSuccess(false); }
    catch { setError(t("settings.folderError")); }
  };
  const generateKey = async () => {
    try { const token = await window.electronAPI.generateToken(); setConfig(current => current ? { ...current, MCP_API_KEY: token } : current); setSavedSuccess(false); }
    catch { setError(t("settings.keyError")); }
  };
  return <Dialog open={isOpen} onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.focus(); }} onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onInteractOutside={event => event.preventDefault()}>
      <div className="settings-header"><div className="settings-header-icon"><Settings2 size={21}/></div><div><DialogTitle className="settings-title">{t("settings.title")}</DialogTitle><DialogDescription className="settings-description">{t("settings.description")}</DialogDescription></div></div>
      {loading ? <div className="settings-loading" role="status"><LoaderCircle className="animate-spin functional-motion" size={24}/><span>{t("settings.loading")}</span></div>
      : !config ? <div className="settings-loading"><p role="alert">{error}</p><Button onClick={onClose}>{t("settings.close")}</Button></div>
      : <form className="settings-form" onSubmit={event => void handleSave(event)}>
        <div className="settings-body">
          <section className="settings-section" aria-labelledby="appearance-section">
            <h3 className="settings-section-heading" id="appearance-section"><Palette/> {t("settings.appearance")}</h3>
            <div className="settings-field"><label htmlFor="interface-language">{t("settings.language")}</label><Select value={lang} onValueChange={value => { if (isLanguage(value)) setLang(value); }}><SelectTrigger id="interface-language" className="mt-2" aria-describedby="interface-language-note"><SelectValue/></SelectTrigger><SelectContent>{languages.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select><small id="interface-language-note">{t("settings.languageNote")}</small></div>
            <div className="settings-toggle-row"><div><label htmlFor="interface-motion">{t("settings.interfaceMotion")}</label><p id="interface-motion-note">{t("settings.interfaceMotionNote")}</p></div><Switch id="interface-motion" checked={animation} onCheckedChange={onAnimationChange} aria-describedby="interface-motion-note"/></div>
            <div className="settings-toggle-row"><div><label htmlFor="background-motion">{t("settings.backgroundMotion")}</label><p id="background-motion-note">{t("settings.backgroundMotionNote")}</p></div><Switch id="background-motion" checked={backgroundAnimation} onCheckedChange={onBackgroundAnimationChange} aria-describedby="background-motion-note"/></div>
            {reducedMotion && <p className="settings-note">{t("settings.reducedMotion")}</p>}
          </section>
          <fieldset disabled={saving} className="contents">
            <TunnelSettings config={config} onChange={updateConfig}/>
            <section className="settings-section" aria-labelledby="server-section">
              <h3 className="settings-section-heading" id="server-section"><Server/> {t("settings.server")}</h3>
              <div className="settings-grid">
                <SettingsField config={config} onChange={updateConfig} name="PORT" label={t("settings.port")} required type="number" min={1} max={65535}/>
                <SettingsField config={config} onChange={updateConfig} name="HOST" label={t("settings.host")} required placeholder="127.0.0.1" note={t("settings.hostNote")}/>
                <SettingsField config={config} onChange={updateConfig} name="COMMAND_TIMEOUT_MS" label={t("settings.timeout")} type="number" min={1} required/>
                <SettingsField config={config} onChange={updateConfig} name="MAX_OUTPUT_BYTES" label={t("settings.maxOutput")} type="number" min={1} required/>
                <SettingsField config={config} onChange={updateConfig} name="MAX_FILE_BYTES" label={t("settings.maxFile")} type="number" min={1} required/>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="security-section">
              <h3 className="settings-section-heading" id="security-section"><Shield/> {t("settings.security")}</h3>
              <div className="settings-field"><label htmlFor={keyId}>{t("settings.apiKey")}</label><div className="settings-actions-row">
                <Input id={keyId} type={showKey ? "text" : "password"} autoComplete="new-password" required minLength={32} value={config.MCP_API_KEY} onChange={event => updateConfig({ ...config, MCP_API_KEY: event.target.value })} aria-describedby={keyId + "-note"}/>
                <Button size="icon" aria-label={showKey ? t("settings.hideKey") : t("settings.showKey")} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff/> : <Eye/>}</Button>
                <Button size="sm" onClick={() => void generateKey()}><KeyRound/> {t("settings.generate")}</Button>
              </div><small id={keyId + "-note"}>{t("settings.apiKeyNote")}</small></div>
              <div className="settings-toggle-row mt-3"><div><label htmlFor="full-access">{t("settings.fullAccess")}</label><p>{t("settings.fullAccessNote")}</p></div><Switch id="full-access" checked={config.FULL_ACCESS === "true"} onCheckedChange={enabled => updateConfig({ ...config, FULL_ACCESS: String(enabled) })}/></div>
              <div className="settings-field mt-3"><label htmlFor={rootId}>{t("settings.root")}</label><div className="settings-actions-row"><Input id={rootId} value={config.FILES_ROOT} required onChange={event => updateConfig({ ...config, FILES_ROOT: event.target.value })}/><Button size="sm" onClick={() => void selectFolder()}><Folder/> {t("settings.browse")}</Button></div></div>
              <div className="mt-3"><SettingsField config={config} onChange={updateConfig} name="ALLOWED_HOSTS" label={t("settings.allowedHosts")} note={t("settings.allowedHostsNote")} required/></div>
            </section>
            <ToolSettings config={config} onChange={updateConfig}/>
          </fieldset>
          {error && <div className="settings-alert settings-error" role="alert"><AlertCircle/><p>{error}</p></div>}
          {savedSuccess && <div className="settings-alert" role="status"><Check/><p>{t("settings.saved")}</p></div>}
        </div>
        <div className="settings-footer"><p>{t("settings.footer")}</p><div className="settings-footer-buttons"><Button variant="ghost" onClick={onClose} disabled={saving}>{savedSuccess ? t("settings.done") : t("settings.cancel")}</Button><Button type="submit" variant="default" disabled={saving || savedSuccess}>{saving ? <RefreshCw className="animate-spin functional-motion"/> : savedSuccess ? <Check/> : <Save/>}{saving ? t("settings.saving") : savedSuccess ? t("settings.savedButton") : t("settings.save")}</Button></div></div>
      </form>}
    </DialogContent>
  </Dialog>;
}
