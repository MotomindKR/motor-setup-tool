import { messageText } from "../i18n.mjs";
import { useTranslation } from "react-i18next";
import React from "react";
import { languageChoice, chooseLanguage } from "../language.mjs";
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
  const { t } = useTranslation();
  const result = s.updateResult;
  const updateMessage =
    messageText(s.updateMessage) ||
    (result && !result.available && t("You have the latest version."));
  return (
    <Dialog
      open={s.settingsOpen}
      onOpenChange={(open) => {
        if (!open) a.closeSettings();
      }}
    >
      <DialogContent className="settings-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("Settings")}</DialogTitle>
        </DialogHeader>
        <Field label={t("Language")}>
          <Choice
            value={languageChoice()}
            onChange={chooseLanguage}
            options={[
              { value: "system", label: t("System") },
              { value: "en", label: "English" },
              { value: "ko", label: "한국어" },
            ]}
          />
        </Field>
        <Field label={t("Appearance")}>
          <Choice
            value={appearance.choice}
            onChange={appearance.setChoice}
            options={[
              { value: "system", label: t("System") },
              { value: "light", label: t("Light") },
              { value: "dark", label: t("Dark") },
            ]}
          />
        </Field>
        <Separator className="control-divider" />
        <div className="version-row">
          <strong>Motor Setup Tool</strong>
          <Badge variant="secondary">
            {s.version ? `v${s.version}` : t("Version unavailable")}
          </Badge>
        </div>
        {result?.available && (
          <p className="field-hint" role="status">
            {t("Version {{version}} is available.", {
              version: result.version,
            })}
          </p>
        )}
        {updateMessage && (
          <p className="field-hint" role="status">
            {updateMessage}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={a.checkUpdate}
            disabled={s.checkingUpdate || s.installingUpdate}
          >
            <RefreshCw className={s.checkingUpdate ? "spinning" : ""} />
            {t("Check for update")}
          </Button>
          {result?.available && (
            <Button
              onClick={() => a.installUpdate(result.version)}
              disabled={c.busy || s.checkingUpdate}
            >
              <ArrowDownToLine />
              {result.releasePage
                ? t("Open download page")
                : t("Install update")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
