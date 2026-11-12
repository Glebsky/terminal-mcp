import { useEffect, useId, useState, type FormEvent } from "react";
import { AlertCircle, Check, Eye, EyeOff, Folder, KeyRound, LoaderCircle, Palette, RefreshCw, Save, Server, Settings2, Shield } from "lucide-react";
import type { EnvConfig } from "../../types";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Switch } from "../lib/shadcn/ui";
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
    void window.electronAPI.getConfig().then(value => { if (!cancelled) setConfig(value); }).catch(() => { if (!cancelled) setError("Unable to load configuration. Close settings and try again."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen]);
  const updateConfig = (value: EnvConfig) => { setConfig(value); setSavedSuccess(false); setError(""); };
  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!config || saving) return;
    setSaving(true); setError(""); setSavedSuccess(false);
    try {
      const result = await window.electronAPI.saveConfig(config);
      if (result.success) { setSavedSuccess(true); onSaved(); }
      else setError(result.error || "Unable to save settings. Your running server was not restarted.");
    } catch { setError("Unable to save settings. Check the configuration folder permissions and try again."); }
    finally { setSaving(false); }
  };
  const selectFolder = async () => {
    try { const selected = await window.electronAPI.selectFolder(); if (selected) setConfig(current => current ? { ...current, FILES_ROOT: selected } : current); setSavedSuccess(false); }
    catch { setError("Unable to open the folder picker."); }
  };
  const generateKey = async () => {
    try { const token = await window.electronAPI.generateToken(); setConfig(current => current ? { ...current, MCP_API_KEY: token } : current); setSavedSuccess(false); }
    catch { setError("Unable to generate a key."); }
  };
  return <Dialog open={isOpen} onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.focus(); }} onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onInteractOutside={event => event.preventDefault()}>
      <div className="settings-header"><div className="settings-header-icon"><Settings2 size={21}/></div><div><DialogTitle className="settings-title">Server settings</DialogTitle><DialogDescription className="settings-description">Liquid Glass workspace · Connection, appearance and security</DialogDescription></div></div>
      {loading ? <div className="settings-loading" role="status"><LoaderCircle className="animate-spin functional-motion" size={24}/><span>Loading configuration…</span></div>
      : !config ? <div className="settings-loading"><p role="alert">{error}</p><Button onClick={onClose}>Close settings</Button></div>
      : <form className="settings-form" onSubmit={event => void handleSave(event)}>
        <div className="settings-body">
          <section className="settings-section" aria-labelledby="appearance-section">
            <h3 className="settings-section-heading" id="appearance-section"><Palette/> Appearance</h3>
            <div className="settings-toggle-row"><div><label htmlFor="interface-motion">Interface animations</label><p id="interface-motion-note">Soft transitions, button feedback and traffic particles. Saved on this device.</p></div><Switch id="interface-motion" checked={animation} onCheckedChange={onAnimationChange} aria-describedby="interface-motion-note"/></div>
            <div className="settings-toggle-row"><div><label htmlFor="background-motion">Background animations</label><p id="background-motion-note">Slow aurora movement. Turning this off stops the animation, not monitoring.</p></div><Switch id="background-motion" checked={backgroundAnimation} onCheckedChange={onBackgroundAnimationChange} aria-describedby="background-motion-note"/></div>
            {reducedMotion && <p className="settings-note">System Reduced Motion is active. Decorative motion stays off regardless of these preferences.</p>}
          </section>
          <fieldset disabled={saving} className="contents">
            <TunnelSettings config={config} onChange={updateConfig}/>
            <section className="settings-section" aria-labelledby="server-section">
              <h3 className="settings-section-heading" id="server-section"><Server/> Server</h3>
              <div className="settings-grid">
                <SettingsField config={config} onChange={updateConfig} name="PORT" label="Listen port" required type="number" min={1} max={65535}/>
                <SettingsField config={config} onChange={updateConfig} name="HOST" label="Listen host" required placeholder="127.0.0.1" note="Prefer loopback when using a tunnel."/>
                <SettingsField config={config} onChange={updateConfig} name="COMMAND_TIMEOUT_MS" label="Command timeout · ms" type="number" min={1} required/>
                <SettingsField config={config} onChange={updateConfig} name="MAX_OUTPUT_BYTES" label="Max command output · bytes" type="number" min={1} required/>
                <SettingsField config={config} onChange={updateConfig} name="MAX_FILE_BYTES" label="Max file payload · bytes" type="number" min={1} required/>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="security-section">
              <h3 className="settings-section-heading" id="security-section"><Shield/> Security & sandbox</h3>
              <div className="settings-field"><label htmlFor={keyId}>MCP Bearer API key</label><div className="settings-actions-row">
                <Input id={keyId} type={showKey ? "text" : "password"} autoComplete="new-password" required minLength={32} value={config.MCP_API_KEY} onChange={event => updateConfig({ ...config, MCP_API_KEY: event.target.value })} aria-describedby={keyId + "-note"}/>
                <Button size="icon" aria-label={showKey ? "Hide MCP key" : "Show MCP key"} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff/> : <Eye/>}</Button>
                <Button size="sm" onClick={() => void generateKey()}><KeyRound/> Generate</Button>
              </div><small id={keyId + "-note"}>At least 32 characters. Agents use Authorization: Bearer &lt;key&gt;. Rotating this key takes effect after restarting the server.</small></div>
              <div className="settings-toggle-row mt-3"><div><label htmlFor="full-access">Unrestricted host access</label><p>Off keeps filesystem access inside the sandbox. Enable only for agents you fully trust.</p></div><Switch id="full-access" checked={config.FULL_ACCESS === "true"} onCheckedChange={enabled => updateConfig({ ...config, FULL_ACCESS: String(enabled) })}/></div>
              <div className="settings-field mt-3"><label htmlFor={rootId}>Sandbox root directory</label><div className="settings-actions-row"><Input id={rootId} value={config.FILES_ROOT} required onChange={event => updateConfig({ ...config, FILES_ROOT: event.target.value })}/><Button size="sm" onClick={() => void selectFolder()}><Folder/> Browse</Button></div></div>
              <div className="mt-3"><SettingsField config={config} onChange={updateConfig} name="ALLOWED_HOSTS" label="Allowed Host headers" note="Separate entries with semicolons. The active tunnel adds only its exact hostname for that session. Do not use a global wildcard." required/></div>
            </section>
            <ToolSettings config={config} onChange={updateConfig}/>
          </fieldset>
          {error && <div className="settings-alert settings-error" role="alert"><AlertCircle/><p>{error}</p></div>}
          {savedSuccess && <div className="settings-alert" role="status"><Check/><p>Settings saved. Restart the server explicitly to apply connection or security changes. The active server was not interrupted.</p></div>}
        </div>
        <div className="settings-footer"><p>Appearance is saved automatically. Server changes require a restart; your running tunnel stays active.</p><div className="settings-footer-buttons"><Button variant="ghost" onClick={onClose} disabled={saving}>{savedSuccess ? "Done" : "Cancel"}</Button><Button type="submit" variant="default" disabled={saving || savedSuccess}>{saving ? <RefreshCw className="animate-spin functional-motion"/> : savedSuccess ? <Check/> : <Save/>}{saving ? "Saving…" : savedSuccess ? "Saved" : "Save changes"}</Button></div></div>
      </form>}
    </DialogContent>
  </Dialog>;
}
