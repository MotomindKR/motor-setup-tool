import React from "react";
import { ArrowDownToLine, RefreshCw } from "lucide-react";
import { Badge } from "@motomindkr/ui/components/badge";
import { Separator } from "@motomindkr/ui/components/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@motomindkr/ui/components/dialog";
import { Button, Field, Choice } from "../ui.jsx";

export function Settings({ s, a, appearance, c }) {
  return (
    <Dialog
      open={s.settingsOpen}
      onOpenChange={(open) => {
        if (!open) a.closeSettings();
      }}
    >
      <DialogContent className="settings-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Field label="Appearance">
          <Choice
            value={appearance.choice}
            onChange={appearance.setChoice}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Field>
        <Separator className="control-divider" />
        <div className="version-row">
          <strong>Motor Setup Tool</strong>
          <Badge variant="secondary">
            {s.version ? `v${s.version}` : "Version unavailable"}
          </Badge>
        </div>
        {s.updateMessage && (
          <p className="field-hint" role="status">
            {s.updateMessage}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={a.checkUpdate}
            disabled={s.checkingUpdate || s.installingUpdate}
          >
            <RefreshCw className={s.checkingUpdate ? "spinning" : ""} />
            Check for update
          </Button>
          {s.updateCandidate && (
            <Button onClick={a.installUpdate} disabled={c.busy}>
              <ArrowDownToLine />
              Install update
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
