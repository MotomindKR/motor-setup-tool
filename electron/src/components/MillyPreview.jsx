import React, { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@motomindkr/ui/components/alert";
import { Badge } from "@motomindkr/ui/components/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@motomindkr/ui/components/dialog";

const MillyViewer = lazy(() => import("./MillyViewer.jsx").then((module) => ({ default: module.MillyViewer })));

export function MillyPreview({ ready, pose, error, visible, onClose }) {
  const { t } = useTranslation();
  const live = Boolean(ready && pose && visible && !error);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="milly-dialog">
        <DialogHeader>
          <DialogTitle>{t("MILLY teaching preview")}</DialogTitle>
          <DialogDescription>{t("Move the teaching device to check its joint directions and zero points.")}</DialogDescription>
        </DialogHeader>
        <div className="milly-status">
          <Badge role="status" variant={live ? "success" : "secondary"}>
            {live ? t("Live") : error || (pose && !visible) ? t("Stale") : t("Waiting for input")}
          </Badge>
          <span>{t("Read only · Gripper travel is estimated")}</span>
        </div>
        {(!ready || error) && <Alert variant={error ? "error" : "info"} role={error ? "alert" : "status"}>
          <AlertDescription>
            {error
              ? t("Preview stopped. Close the preview and check the teaching device connection.")
              : t("Scan for XL330-M288-T on IDs 40–45 and XL330-M077-T on ID 46.")}
            {error && <p>{error}</p>}
          </AlertDescription>
        </Alert>}
        <Suspense fallback={<p role="status">{t("Loading the MILLY model…")}</p>}>
          <MillyViewer pose={pose} />
        </Suspense>
        {pose && <ul className="milly-joints" aria-label={t("Mapped joint positions")}>
          {pose.map(({ name, id, position, measured, limited }, index) => (
            <li key={name}>
              <span>{name === "gripper" ? t("Gripper") : t("Joint {{number}}", { number: index + 1 })}</span>
              <small>ID {id}</small>
              <strong>{measured.toFixed(3)} rad</strong>
              {limited && <small>{t("Model limited to {{position}} rad", { position: position.toFixed(3) })}</small>}
            </li>
          ))}
        </ul>}
      </DialogContent>
    </Dialog>
  );
}
