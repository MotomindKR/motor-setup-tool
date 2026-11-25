import { useTranslation } from "react-i18next";
import React from "react";
import { Camera, CircuitBoard, Settings2, Usb } from "lucide-react";
import { MotomindLogo } from "@motomindkr/ui/components/motomind-logo";
import { MotomindSymbol } from "@motomindkr/ui/components/motomind-symbol";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@motomindkr/ui/components/sidebar";
import { workspaces } from "../workspaces.mjs";

const workspaceIcons = { robstride: CircuitBoard, dynamixel: Usb, camera: Camera };

export function AppSidebar({
  activeWorkspace,
  onNavigate,
  onSettings,
  updateAvailable,
}) {
  const { t } = useTranslation();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const compact = state === "collapsed" && !isMobile;
  const navigate = (workspace) => {
    if (isMobile) setOpenMobile(false);
    onNavigate(workspace);
  };
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
          <SidebarGroupLabel>{t("Hardware workspaces")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label={t("Hardware workspaces")}>
              <SidebarMenu className="app-sidebar-menu">
                {Object.entries(workspaces).map(([key, workspace]) => {
                  const Icon = workspaceIcons[key];
                  const active = activeWorkspace === key;
                  const label = t(workspace.label);
                  return (
                    <SidebarMenuItem key={key}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={active}
                        aria-current={active || undefined}
                        aria-label={label}
                        tooltip={label}
                        onClick={() => navigate(key)}
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
