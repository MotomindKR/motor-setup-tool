import { useTranslation } from "react-i18next";
import React from "react";
import { Settings2 } from "lucide-react";
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

export function AppSidebar({
  pages,
  activeTab,
  onNavigate,
  onSettings,
  updateAvailable,
}) {
  const { t } = useTranslation();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const compact = state === "collapsed" && !isMobile;
  const navigate = (tab) => {
    if (isMobile) setOpenMobile(false);
    onNavigate(tab);
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
          <SidebarGroupLabel>{t("Workspace")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label={t("Tool sections")}>
              <SidebarMenu className="app-sidebar-menu">
                {Object.entries(pages).map(([key, page]) => {
                  const Icon = page.icon;
                  return (
                    <SidebarMenuItem key={key}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={activeTab === key}
                        aria-current={activeTab === key ? "page" : undefined}
                        aria-label={t(page.label)}
                        tooltip={t(page.label)}
                        onClick={() => navigate(key)}
                      >
                        <Icon />
                        <span>{t(page.label)}</span>
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
