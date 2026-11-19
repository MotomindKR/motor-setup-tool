import React, { useEffect, useState, useSyncExternalStore } from "react";
import {
  Activity,
  CircleAlert,
  CircleStop,
  Folder,
  Info,
  Settings2,
  SlidersHorizontal,
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
import { FilesPage } from "./pages/Recordings.jsx";
import { AppSidebar } from "./components/AppSidebar.jsx";
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
  const enabled = c.manual && s.manualStatus?.enabled;
  const issue = s.motor?.issue || (c.fresh && s.manualStatus?.faults);
  const label = issue
    ? "Needs attention"
    : enabled
      ? "Motor enabled"
      : c.manual
        ? "Monitoring"
        : s.busy
          ? "Working"
          : c.motor
            ? "Connected"
            : "Not connected";
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
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const a = controller.actions,
    appearance = useTheme();
  const c = controls(s, controller.platform);
  const page = pages[s.tab];
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [s.tab, s.directory]);
  useEffect(() => {
    if (
      s.tab === "setup" &&
      s.motor?.model &&
      !c.busy &&
      !s.registers &&
      !s.registersFailed
    )
      a.loadRegisters();
  }, [s.tab, s.motor?.model, c.busy, s.registers, s.registersFailed, a]);
  useEffect(() => {
    if (window.motorSmoke) window.motorSmoke.setTheme = appearance.setChoice;
  }, [appearance.setChoice]);
  useEffect(() => {
    const cleanup = controller.start();
    const revoke = () => a.revoke(),
      release = () => a.release();
    const visibility = () => {
      if (document.hidden) revoke();
    };
    window.addEventListener("blur", revoke);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("blur", revoke);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      cleanup();
    };
  }, [controller, a]);
  return (
    <UIProvider locale="en">
      <SidebarProvider className="app-frame">
        <a className="skip-link" href="#workspace">
          Skip to workspace
        </a>
        <header className="app-header">
          <div className="header-navigation">
            <SidebarTrigger />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>Workspace</BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{page.title}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div className="header-actions">
            <Status s={s} c={c} />
            {s.motor && s.tab !== "test" && (
              <>
                <Separator
                  orientation="vertical"
                  className="header-control-divider"
                />
                <Button
                  className="header-disable"
                  variant="ghost"
                  size="sm"
                  aria-label="Disable motor"
                  onClick={a.disable}
                  disabled={!c.disable}
                >
                  <CircleStop />
                  Disable motor
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
          <SidebarInset className="app-body" aria-label={page.title}>
            <div id="workspace" className="workspace" tabIndex={-1}>
              {s.notice && (
                <Alert
                  className="app-notice"
                  variant={s.notice.error ? "error" : "info"}
                  role={s.notice.error ? "alert" : "status"}
                >
                  {s.notice.error ? <CircleAlert /> : <Info />}
                  <AlertDescription>{s.notice.message}</AlertDescription>
                  <Button
                    className="notice-close"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Dismiss message"
                    onClick={a.dismissNotice}
                  >
                    <X />
                  </Button>
                </Alert>
              )}
              {s.tab !== "files" && (
                <Connection s={s} a={a} c={c} platform={controller.platform} />
              )}
              {s.work &&
                ![
                  "manual",
                  "interfaces",
                  "usbAdapters",
                  "registerList",
                  "plan",
                ].includes(s.busy) && (
                  <Panel
                    className="work-panel"
                    size="md"
                    title={s.work.title}
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={a.cancel}
                        disabled={s.busy === "firmwareUpdate"}
                      >
                        <CircleStop />
                        Stop
                      </Button>
                    }
                  >
                    <div className="work-message">
                      <p role="status">{s.work.message || "Please wait…"}</p>
                      {s.work.percent != null && <span>{s.work.percent}%</span>}
                    </div>
                    <Progress
                      value={s.work.percent}
                      aria-label={s.work.title}
                    />
                  </Panel>
                )}
              {s.tab === "calibrate" && <CalibratePage s={s} a={a} c={c} />}
              {s.tab === "test" && <TestPage s={s} a={a} c={c} />}
              {s.tab === "setup" && <SetupPage s={s} a={a} c={c} />}
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
                Cancel
              </Button>
              <Button
                variant={
                  s.confirmation?.destructive ? "destructive" : "default"
                }
                onClick={a.confirm}
              >
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SidebarProvider>
    </UIProvider>
  );
}
