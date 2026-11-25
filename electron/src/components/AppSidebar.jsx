import { useTranslation } from "react-i18next";
import React from "react";
import {
  Activity,
  Camera,
  CircuitBoard,
  Folder,
  Settings2,
  SlidersHorizontal,
  Usb,
} from "lucide-react";
import { MotomindLogo } from "@motomindkr/ui/components/motomind-logo";
import { MotomindSymbol } from "@motomindkr/ui/components/motomind-symbol";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@motomindkr/ui/components/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@motomindkr/ui/components/select";
import { workspaces } from "../workspaces.mjs";

const workspaceIcons = { robstride: CircuitBoard, dynamixel: Usb, camera: Camera };
const toolIcons = {
  calibrate: SlidersHorizontal,
  test: Activity,
  setup: Settings2,
  files: Folder,
  dxl: Usb,
  camera: Camera,
};

export function AppSidebar({
  activeWorkspace,
  activeTab,
  onWorkspaceChange,
  onNavigate,
  onSettings,
  updateAvailable,
}) {
  const { t } = useTranslation();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const compact = state === "collapsed" && !isMobile;
  const workspace = workspaces[activeWorkspace];
  const workspaceName = t(workspace.label);
  const WorkspaceIcon = workspaceIcons[activeWorkspace];
  const workspaceOptions = Object.entries(workspaces).map(([value, workspace]) => ({
    value,
    label: t(workspace.label),
  }));
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="app-sidebar-header">
        {compact ? (
          <MotomindSymbol />
        ) : (
          <>
            <MotomindLogo />
            <span className="sidebar-product-name">Motor Setup Tool</span>
          </>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="app-sidebar-group">
          <Select
            value={activeWorkspace}
            items={workspaceOptions}
            onValueChange={(workspace) => {
              if (isMobile) setOpenMobile(false);
              onWorkspaceChange(workspace);
            }}
          >
            <SelectTrigger
              className="workspace-picker"
              aria-label={t("Workspace")}
              aria-description={workspaceName}
              title={compact ? workspaceName : undefined}
            >
              <WorkspaceIcon aria-hidden="true" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              {workspaceOptions.map(({ value, label }) => {
                const Icon = workspaceIcons[value];
                return (
                  <SelectItem key={value} value={value}>
                    <Icon aria-hidden="true" />
                    {label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <SidebarGroupContent>
            <nav
              aria-label={t("{{workspace}} tools", { workspace: workspaceName })}
            >
              <SidebarMenu className="app-sidebar-menu">
                {Object.entries(workspace.pages).map(([key, page]) => {
                  const Icon = toolIcons[key] ?? WorkspaceIcon;
                  const active = activeTab === key;
                  const label = t(page.label ?? page.breadcrumb ?? page.title);
                  return (
                    <SidebarMenuItem key={key}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={active}
                        aria-current={active ? "page" : undefined}
                        aria-label={label}
                        tooltip={label}
                        onClick={() => {
                          if (isMobile) setOpenMobile(false);
                          onNavigate(key);
                        }}
                      >
                        <Icon aria-hidden="true" />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator className="app-sidebar-separator" />
      <SidebarFooter className="app-sidebar-footer">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={t("Settings")}
              aria-description={updateAvailable ? t("Update available") : undefined}
              tooltip={
                updateAvailable ? t("Settings · Update available") : t("Settings")
              }
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                onSettings();
              }}
            >
              <span className="settings-menu-icon" aria-hidden="true">
                <Settings2 />
                {updateAvailable && <span className="settings-update-dot" />}
              </span>
              <span>{t("Settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
