import { messageText } from "./i18n.mjs";
import { useTranslation } from "react-i18next";
import React, { useEffect, useState, useSyncExternalStore } from "react";
import {
  Activity,
  Camera,
  CircleAlert,
  CircleStop,
  Folder,
  Info,
  Settings2,
  SlidersHorizontal,
  Usb,
  X,
} from "lucide-react";
import { UIProvider } from "@motomindkr/ui/components/ui-provider";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@motomindkr/ui/components/sidebar";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@motomindkr/ui/components/breadcrumb";
import { Separator } from "@motomindkr/ui/components/separator";
import { Alert, AlertDescription } from "@motomindkr/ui/components/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@motomindkr/ui/components/dialog";
import { Progress } from "@motomindkr/ui/components/progress";
import { Button, Panel } from "./ui.jsx";
import { controls } from "./controller.mjs";
import { Connection } from "./components/Connection.jsx";
import { Settings } from "./components/Settings.jsx";
import { CalibratePage } from "./pages/Calibration.jsx";
import { TestPage } from "./pages/Test.jsx";
import { SetupPage } from "./pages/Setup.jsx";
import { DxlPage } from "./pages/Dxl.jsx";
import { CameraPage } from "./pages/Camera.jsx";
import { FilesPage } from "./pages/Recordings.jsx";
import { AppSidebar } from "./components/AppSidebar.jsx";
import { progressText } from "./format.mjs";
import { syncWindowTheme } from "./window-theme.mjs";

const pages = {
  calibrate: {
    label: "Calibrate",
    title: "Calibration",
    icon: SlidersHorizontal,
  },
  test: {
    label: "Test",
    title: "Motor test",
    icon: Activity,
  },
  setup: {
    label: "Setup",
    title: "Motor setup",
    icon: Settings2,
  },
  dxl: {
    label: "Dynamixel",
    title: "Dynamixel setup",
    icon: Usb,
  },
  camera: {
    label: "Camera",
    title: "Camera verification",
    icon: Camera,
  },
  files: {
    label: "Files",
    title: "Recordings",
    icon: Folder,
  },
};

function useTheme() {
  const [choice, setChoice] = useState(() => {
    try {
      const value = localStorage.getItem("motomind-appearance");
      return ["system", "light", "dark"].includes(value) ? value : "system";
    } catch {
      return "system";
    }
  });
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem("motomind-appearance", choice);
    } catch {}
    return syncWindowTheme(window.motorApp, choice, theme);
  }, [theme, choice]);
  return { choice, setChoice };
}

function Status({ s, c }) {
  const { t } = useTranslation();
  const enabled = c.manual && s.manualStatus?.enabled;
  const issue = s.motor?.issue || (c.fresh && s.manualStatus?.faults);
  const label = issue
    ? t("Needs attention")
    : enabled
      ? t("Motor enabled")
      : c.manual
        ? t("Monitoring")
        : s.busy
          ? t("Working")
          : c.motor
            ? t("Connected")
            : t("Not connected");
  return (
    <span
      className="connection-badge header-status"
      role="status"
      data-state={
        issue
          ? "error"
          : enabled
            ? "warning"
            : c.motor
              ? "connected"
              : "disconnected"
      }
    >
      <span className="header-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function App({ controller }) {
  const { t, i18n } = useTranslation();
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const a = controller.actions,
    appearance = useTheme();
  const c = controls(s, controller.platform);
  const page = pages[s.tab];
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [s.tab, s.directory]);
  useEffect(() => {
    const cleanup = controller.start();
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    window.addEventListener("blur", a.revoke, options);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) a.revoke();
    }, options);
    window.addEventListener("pointerup", a.release, options);
    window.addEventListener("pointercancel", a.release, options);
    return () => {
      listeners.abort();
      cleanup();
    };
  }, [controller, a]);
  return (
    <UIProvider locale={i18n.language}>
      <SidebarProvider className="app-frame">
        <a className="skip-link" href="#workspace">
          {t("Skip to workspace")}
        </a>
        <header className="app-header">
          <div className="header-navigation">
            <SidebarTrigger />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>{t("Workspace")}</BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{t(page.title)}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div className="header-actions">
            {s.tab !== "dxl" && (s.tab !== "camera" || s.motor) && <Status s={s} c={c} />}
            {s.motor && s.tab !== "test" && s.tab !== "dxl" && (
              <>
                <Separator
                  orientation="vertical"
                  className="header-control-divider"
                />
                <Button
                  className="header-disable"
                  variant="ghost"
                  size="sm"
                  aria-label={t("Disable motor")}
                  onClick={a.disable}
                  disabled={!c.disable}
                >
                  <CircleStop />
                  {t("Disable motor")}
                </Button>
              </>
            )}
          </div>
        </header>
        <div className="app-layout">
          <AppSidebar
            pages={pages}
            activeTab={s.tab}
            onNavigate={a.setTab}
            onSettings={a.openSettings}
            updateAvailable={s.updateResult?.available}
          />
          <SidebarInset className="app-body" aria-label={t(page.title)}>
            <div id="workspace" className="workspace" tabIndex={-1}>
              {s.notice && (
                <Alert
                  className="app-notice"
                  variant={s.notice.error ? "error" : "info"}
                  role={s.notice.error ? "alert" : "status"}
                >
                  {s.notice.error ? <CircleAlert /> : <Info />}
                  <AlertDescription>{messageText(s.notice.message)}</AlertDescription>
                  <Button
                    className="notice-close"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("Dismiss message")}
                    onClick={a.dismissNotice}
                  >
                    <X />
                  </Button>
                </Alert>
              )}
              {s.tab !== "files" && s.tab !== "dxl" && s.tab !== "camera" && (
                <Connection s={s} a={a} c={c} platform={controller.platform} />
              )}
              {s.work &&
                ![
                  "manual",
                  "interfaces",
                  "usbAdapters",
                  "plan",
                ].includes(s.busy) && (
                  <Panel
                    className="work-panel"
                    size="md"
                    title={t(s.work.title)}
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={a.cancel}
                        disabled={s.busy === "firmwareUpdate"}
                      >
                        <CircleStop />
                        {t("Stop")}
                      </Button>
                    }
                  >
                    <div className="work-message">
                      <p role="status">{s.work.message ? progressText(s.work, t) : t("Please wait…")}</p>
                      {s.work.percent != null && <span>{s.work.percent}%</span>}
                    </div>
                    <Progress
                      value={s.work.percent}
                      aria-label={t(s.work.title)}
                    />
                  </Panel>
                )}
              {s.tab === "calibrate" && <CalibratePage s={s} a={a} c={c} />}
              {s.tab === "test" && <TestPage s={s} a={a} c={c} />}
              {s.tab === "setup" && <SetupPage s={s} a={a} c={c} />}
              <DxlPage platform={controller.platform} active={s.tab === "dxl"} />
              {s.tab === "camera" && <CameraPage />}
              {s.tab === "files" && <FilesPage s={s} a={a} c={c} />}
            </div>
          </SidebarInset>
        </div>
        <Settings s={s} a={a} appearance={appearance} c={c} />
        <Dialog
          open={Boolean(s.confirmation)}
          onOpenChange={(open) => {
            if (!open) a.closeConfirmation();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{s.confirmation?.title}</DialogTitle>
              <DialogDescription>
                {s.confirmation?.description}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={a.closeConfirmation}>
                {t("Cancel")}
              </Button>
              <Button
                variant={
                  s.confirmation?.destructive ? "destructive" : "default"
                }
                onClick={a.confirm}
              >
                {t("Confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SidebarProvider>
    </UIProvider>
  );
}
