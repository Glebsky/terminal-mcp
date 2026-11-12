import { Wrench } from "lucide-react";
import type { EnvConfig } from "../../types";
import { allToolNames, parseDisabledTools, serializeDisabledTools, toolGroups } from "../../tool-catalog";
import { Button, Switch } from "../lib/shadcn/ui";

export function ToolSettings({ config, onChange }: { config: EnvConfig; onChange: (config: EnvConfig) => void }) {
  const disabled = parseDisabledTools(config.DISABLED_TOOLS ?? "");
  const enabledTotal = allToolNames.filter(name => !disabled.has(name)).length;

  const commit = (next: Set<string>) => onChange({ ...config, DISABLED_TOOLS: serializeDisabledTools(next) });
  const setTools = (names: string[], enabled: boolean) => {
    const next = new Set(disabled);
    for (const name of names) {
      if (enabled) next.delete(name);
      else next.add(name);
    }
    commit(next);
  };

  return <section className="settings-section" aria-labelledby="tools-section">
    <h3 className="settings-section-heading" id="tools-section"><Wrench/> MCP tools</h3>
    <div className="settings-tools-summary">
      <p className="settings-note">Disabled tools are hidden from agents and cannot be called. {enabledTotal} of {allToolNames.length} enabled. Restart the server to apply.</p>
      <div className="settings-tools-actions">
        <Button size="sm" variant="ghost" onClick={() => setTools(allToolNames, true)} disabled={enabledTotal === allToolNames.length}>Enable all</Button>
      </div>
    </div>
    {toolGroups.map(group => {
      const names = group.tools.map(tool => tool.name);
      const enabledInGroup = names.filter(name => !disabled.has(name)).length;
      const groupId = "tool-group-" + group.id;
      return <div key={group.id} className="settings-tool-group">
        <div className="settings-toggle-row settings-tool-group-head">
          <div>
            <label htmlFor={groupId}>{group.title} <span className="settings-tool-count">{enabledInGroup}/{names.length}</span></label>
            <p>{group.description}</p>
          </div>
          <Switch id={groupId} checked={enabledInGroup > 0} onCheckedChange={enabled => setTools(names, enabled)} aria-label={"Toggle all " + group.title + " tools"}/>
        </div>
        {group.tools.map(tool => {
          const toolId = "tool-" + tool.name;
          return <div key={tool.name} className="settings-toggle-row settings-tool-row">
            <div>
              <label htmlFor={toolId}><code>{tool.name}</code></label>
              <p>{tool.description}</p>
            </div>
            <Switch id={toolId} checked={!disabled.has(tool.name)} onCheckedChange={enabled => setTools([tool.name], enabled)}/>
          </div>;
        })}
      </div>;
    })}
  </section>;
}
